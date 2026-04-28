import { Hono } from "hono";
import { Agent } from "@openai/agents";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { authMiddleware, originGuard } from "./middleware/auth";
import { errorBoundary } from "./middleware/error";
import type { GatewayConfig } from "./env";
import { openDatabase } from "./persistence/sqlite";
import { applyMigrations } from "./persistence/migrate";
import { importLegacy } from "./migration/importLegacy";
import { ProfileStore } from "./domain/profileStore";
import { WorkspaceStore } from "./domain/workspaceStore";
import { AgentStore } from "./domain/agentStore";
import { ConversationStore } from "./domain/conversationStore";
import { MessageStore } from "./domain/messageStore";
import { AttachmentStore } from "./domain/attachmentStore";
import { RunStore } from "./domain/runStore";
import { ConversationContextStore } from "./domain/conversationContextStore";
import { profileRouter } from "./routes/profile";
import { workspacesRouter } from "./routes/workspaces";
import { agentsRouter } from "./routes/agents";
import { skillsRouter } from "./routes/skills";
import { memoriesRouter } from "./routes/memories";
import { conversationsRouter } from "./routes/conversations";
import { runsRouter, type ResumeRunResult } from "./routes/runs";
import { attachmentsRouter } from "./routes/attachments";
import { mcpServersRouter } from "./routes/mcpServers";
import {
  assembleAgentInstructions,
  type ToolCallable,
} from "@vulture/agent-runtime";
import { selectModel } from "@vulture/llm";
import { AGENT_TOOL_NAMES } from "@vulture/protocol/src/v1/agent";
import { ApprovalQueue } from "./runtime/approvalQueue";
import { makeShellApprovalHandler, makeShellCallbackTools } from "./runtime/shellCallbackTools";
import { makeGatewayLocalTools } from "./runtime/gatewayLocalTools";
import { makeLazyLlm } from "./runtime/resolveLlm";
import { orchestrateRun } from "./runtime/runOrchestrator";
import { recoverInflightRuns } from "./runtime/runRecovery";
import { extractMemorySuggestions } from "./runtime/memorySuggestionExtractor";
import {
  composeSystemPromptWithContext,
  makeSdkTool,
  sdkStateHasInterruptions,
  type SdkRunContext,
} from "./runtime/openaiLlm";
import { filterSkillEntries, formatSkillsForPrompt, loadSkillEntries } from "./runtime/skills";
import { MemoryStore } from "./domain/memoryStore";
import { MemoryFileStore } from "./domain/memoryFileStore";
import { McpServerStore } from "./domain/mcpServerStore";
import { makeOpenAIEmbeddingProvider } from "./runtime/openaiEmbeddings";
import { McpClientManager } from "./runtime/mcpClientManager";
import { combineContextPrompts } from "./routes/runs";

export function buildServer(cfg: GatewayConfig): Hono {
  const dbPath = join(cfg.profileDir, "data.sqlite");
  const db = openDatabase(dbPath);
  applyMigrations(db);

  const importResult = importLegacy({
    profileDir: cfg.profileDir,
    db,
    privateWorkspaceHomeDir: cfg.privateWorkspaceHomeDir,
  });
  if (importResult.agentsImported || importResult.workspacesImported) {
    console.log(
      `[gateway] migrated ${importResult.agentsImported} agents + ${importResult.workspacesImported} workspaces from legacy file store`,
    );
  }

  const profileStore = new ProfileStore(db, cfg.profileDir);
  const workspaceStore = new WorkspaceStore(db);
  const agentStore = new AgentStore(
    db,
    cfg.profileDir,
    cfg.defaultWorkspace,
    cfg.privateWorkspaceHomeDir,
  );
  const conversationStore = new ConversationStore(db);
  const messageStore = new MessageStore(db);
  const attachmentStore = new AttachmentStore(db, cfg.profileDir);
  const runStore = new RunStore(db);
  const conversationContextStore = new ConversationContextStore(db);
  const memoryStore = new MemoryStore(db);
  const mcpServerStore = new McpServerStore(db);
  const mcpClientManager = new McpClientManager(mcpServerStore);
  const embedMemoryText = makeOpenAIEmbeddingProvider();
  const memoryFileStore = new MemoryFileStore({ db, legacy: memoryStore, embed: embedMemoryText });
  const memoryExtractionLlm = makeLazyLlm({
    toolNames: [],
    toolCallable: async () => {
      throw new Error("memory extraction does not allow tools");
    },
    shellCallbackUrl: cfg.shellCallbackUrl,
    shellToken: cfg.token,
  });
  const contextCompactionLlm = makeLazyLlm({
    toolNames: [],
    toolCallable: async () => {
      throw new Error("conversation context compaction does not allow tools");
    },
    shellCallbackUrl: cfg.shellCallbackUrl,
    shellToken: cfg.token,
  });

  // Ensure every agent's workspace directory exists. shell.exec sets cwd to
  // workspace.path; if that path is missing the spawn fails with a misleading
  // "No such file or directory". Cheap to run on every boot.
  for (const agent of agentStore.list()) {
    try {
      mkdirSync(agent.workspace.path, { recursive: true });
    } catch {
      // ignore — surfaces later as a clear cwd error from tool_executor
    }
  }

  // Agent-pack root for the local-work pack (only pack in Phase 3a). Move from
  // apps/desktop-shell/agent-packs/ → apps/gateway/agent-packs/ happens in
  // Task 18; this path resolves to the new location.
  const packDir = join(import.meta.dir, "..", "agent-packs");

  const approvalQueue = new ApprovalQueue();
  const cancelSignals = new Map<string, AbortController>();

  const shellTools: ToolCallable = makeShellCallbackTools({
    callbackUrl: cfg.shellCallbackUrl,
    token: cfg.token,
    appendEvent: (runId, partial) => runStore.appendEvent(runId, partial),
    approvalQueue,
    cancelSignals,
    interactiveApprovalFallback: false,
  });
  let llm: ReturnType<typeof makeLazyLlm>;
  let tools: ToolCallable;
  const systemPromptForAgent = ({ id }: { id: string }): string => {
    const agent = agentStore.get(id);
    if (!agent) return "";
    return assembleAgentInstructions({
      packDir: join(packDir, "local-work"),
      agent: {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        instructions: agent.instructions,
        tools: agent.tools,
        model: agent.model,
        reasoning: agent.reasoning,
      },
      workspace: {
        id: agent.workspace.id,
        name: agent.workspace.name,
        path: agent.workspace.path,
      },
    });
  };
  const modelForAgent = ({ id }: { id: string }): string =>
    selectModel(agentStore.get(id)?.model ?? "");
  const workspacePathForAgent = ({ id }: { id: string }): string =>
    agentStore.get(id)?.workspace.path ?? "";
  const skillsPromptForAgent = ({ id }: { id: string }): string => {
    const agent = agentStore.get(id);
    if (!agent) return "";
    const entries = loadSkillEntries({
      workspaceDir: agent.workspace.path,
      profileDir: cfg.profileDir,
    });
    return formatSkillsForPrompt(filterSkillEntries(entries, agent.skills));
  };
  const memoryPromptForRun = async ({ agentId }: { agentId: string; input: string }): Promise<string> => {
    const agent = agentStore.get(agentId);
    return agent ? memoryFileStore.contextPrompt(agent) : "";
  };
  const contextPromptForRun = async (agentId: string, input: string): Promise<string | undefined> =>
    combineContextPrompts(
      await memoryPromptForRun({ agentId, input }),
      skillsPromptForAgent({ id: agentId }),
    );
  const afterRunSucceeded = async (input: {
    runId: string;
    conversationId: string;
    agentId: string;
    model: string;
    userInput: string;
    finalText: string;
    workspacePath: string;
  }) => {
    if (cfg.memorySuggestionsEnabled === false) return;
    const agent = agentStore.get(input.agentId);
    if (!agent) return;
    const memorySummary = memoryFileStore
      .listChunks(input.agentId)
      .slice(0, 8)
      .map((chunk) => chunk.content)
      .join("\n\n");
    const suggestions = await extractMemorySuggestions({
      llm: memoryExtractionLlm,
      model: input.model,
      workspacePath: input.workspacePath,
      runId: input.runId,
      userInput: input.userInput,
      assistantOutput: input.finalText,
      memorySummary,
    });
    for (const suggestion of suggestions) {
      memoryFileStore.createSuggestion({
        agentId: input.agentId,
        runId: input.runId,
        conversationId: input.conversationId,
        content: suggestion.content,
        reason: suggestion.reason,
        targetPath: suggestion.targetPath,
      });
    }
  };
  const startConversationRun = async (conversationId: string, input: string) => {
    const conv = conversationStore.get(conversationId);
    if (!conv) throw new Error(`conversation not found: ${conversationId}`);
    const userMsg = messageStore.append({
      conversationId,
      role: "user",
      content: input,
      runId: null,
    });
    const run = runStore.create({
      conversationId,
      agentId: conv.agentId,
      triggeredByMessageId: userMsg.id,
    });
    orchestrateRun(
      {
        runs: runStore,
        messages: messageStore,
        conversations: conversationStore,
        llm,
        tools,
        cancelSignals,
        afterRunSucceeded,
      },
      {
        runId: run.id,
        agentId: conv.agentId,
        model: modelForAgent({ id: conv.agentId }),
        systemPrompt: systemPromptForAgent({ id: conv.agentId }),
        contextPrompt: await contextPromptForRun(conv.agentId, input),
        workspacePath: workspacePathForAgent({ id: conv.agentId }),
        conversationId,
        userInput: input,
      },
    ).catch((err) => {
      runStore.markFailed(run.id, {
        code: "internal",
        message: err instanceof Error ? err.message : String(err),
      });
    });
    return { conversationId, runId: run.id, messageId: userMsg.id };
  };
  tools = makeGatewayLocalTools({
    shellTools,
    appendEvent: (runId, partial) => runStore.appendEvent(runId, partial),
    mcp: {
      canHandle: (toolName) => mcpClientManager.canHandle(toolName),
      execute: (call) => mcpClientManager.executeToolCall(call),
    },
    sessions: {
      list: (input) => {
        const limit = typeof (input as { limit?: unknown }).limit === "number"
          ? (input as { limit: number }).limit
          : 20;
        return conversationStore.list().slice(0, limit).map((conversation) => ({
          id: conversation.id,
          agentId: conversation.agentId,
          title: conversation.title,
          createdAt: conversation.createdAt,
          updatedAt: conversation.updatedAt,
          activeRuns: runStore.listForConversation(conversation.id, { status: "active" }),
        }));
      },
      history: (input) => {
        const value = input as { conversationId?: unknown; limit?: unknown };
        if (typeof value.conversationId !== "string") {
          throw new Error("sessions_history missing conversationId");
        }
        const limit = typeof value.limit === "number" ? value.limit : 50;
        const messages = messageStore.listSince({ conversationId: value.conversationId });
        return messages.slice(-limit);
      },
      send: async (input) => {
        const value = input as { conversationId?: unknown; message?: unknown };
        if (typeof value.conversationId !== "string" || typeof value.message !== "string") {
          throw new Error("sessions_send missing conversationId/message");
        }
        return startConversationRun(value.conversationId, value.message);
      },
      spawn: async (input) => {
        const value = input as { agentId?: unknown; title?: unknown; message?: unknown };
        const agentId =
          typeof value.agentId === "string" && value.agentId.length > 0
            ? value.agentId
            : "local-work-agent";
        if (!agentStore.get(agentId)) throw new Error(`agent not found: ${agentId}`);
        const conversation = conversationStore.create({
          agentId,
          title: typeof value.title === "string" ? value.title : "",
        });
        if (typeof value.message === "string" && value.message.length > 0) {
          return { ...(await startConversationRun(conversation.id, value.message)), conversation };
        }
        return { conversation, runId: null };
      },
      yield: () => ({
        activeRuns: conversationStore
          .list()
          .flatMap((conversation) => runStore.listForConversation(conversation.id, { status: "active" })),
      }),
    },
    memory: {
      search: async (call) => {
        const agent = agentForWorkspace(call.workspacePath);
        const value = call.input as { query?: unknown; limit?: unknown };
        if (typeof value.query !== "string" || value.query.trim().length === 0) {
          throw new Error("memory_search missing query");
        }
        const limit = typeof value.limit === "number" ? value.limit : 5;
        const results = await memoryFileStore.search(agent, value.query, limit);
        return {
          items: results.map((result) => ({
            id: result.memory.id,
            path: "path" in result.memory ? result.memory.path : "MEMORY.md",
            heading: "heading" in result.memory ? result.memory.heading : null,
            score: result.score,
            source: result.source,
            snippet: truncateMemorySnippet(result.memory.content),
          })),
        };
      },
      get: async (call) => {
        const agent = agentForWorkspace(call.workspacePath);
        const value = call.input as { id?: unknown; path?: unknown };
        if (typeof value.id === "string" && value.id.length > 0) {
          const chunk = memoryFileStore.getChunk(agent.id, value.id);
          if (!chunk) throw new Error(`memory chunk not found: ${value.id}`);
          return {
            id: chunk.id,
            path: chunk.path,
            heading: chunk.heading,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
            content: chunk.content,
          };
        }
        if (typeof value.path === "string" && value.path.length > 0) {
          return memoryFileStore.getFile(agent, value.path);
        }
        throw new Error("memory_get requires id or path");
      },
      append: async (call) => {
        const agent = agentForWorkspace(call.workspacePath);
        const value = call.input as { path?: unknown; content?: unknown };
        if (typeof value.path !== "string" || typeof value.content !== "string") {
          throw new Error("memory_append missing path/content");
        }
        const chunks = await memoryFileStore.append(agent, value.path, value.content);
        return {
          path: value.path,
          items: chunks.map((chunk) => ({
            id: chunk.id,
            path: chunk.path,
            heading: chunk.heading,
            startLine: chunk.startLine,
            endLine: chunk.endLine,
          })),
        };
      },
    },
  });
  const approvalCallable = makeShellApprovalHandler({
    callbackUrl: cfg.shellCallbackUrl,
    token: cfg.token,
    appendEvent: (runId, partial) => runStore.appendEvent(runId, partial),
    approvalQueue,
    cancelSignals,
  });

  llm = makeLazyLlm({
    toolNames: AGENT_TOOL_NAMES,
    toolCallable: tools,
    approvalCallable,
    mcpToolProvider: () => mcpClientManager.getSdkToolsForRun(),
    shellCallbackUrl: cfg.shellCallbackUrl,
    shellToken: cfg.token,
  });
  void mcpClientManager.getSdkToolsForRun().catch((err) => {
    console.warn("[gateway] MCP startup discovery failed", err instanceof Error ? err.message : String(err));
  });

  const resumeRun = (runId: string, mode: "auto" | "manual"): ResumeRunResult => {
    const state = runStore.getRecoveryState(runId);
    const run = runStore.get(runId);
    if (!run) return { status: "missing_state" };
    if (!state) {
      runStore.markFailed(runId, {
        code: "internal.recovery_state_unavailable",
        message: `recovery state unavailable for ${runId}`,
      });
      return { status: "missing_state" };
    }
    if (!runStore.claimRecoverable(runId)) return { status: "already_started" };

    runStore.appendEvent(runId, {
      type: "run.recovered",
      mode,
      discardPriorDraft: true,
    });

    orchestrateRun(
      {
        runs: runStore,
        messages: messageStore,
        conversations: conversationStore,
        llm,
        tools,
        cancelSignals,
      },
      {
        runId,
        agentId: state.metadata.agentId,
        model: state.metadata.model,
        systemPrompt: state.metadata.systemPrompt,
        contextPrompt: state.metadata.contextPrompt,
        workspacePath: state.metadata.workspacePath,
        conversationId: state.metadata.conversationId,
        userInput: state.metadata.userInput,
        recovery: {
          sdkState: state.sdkState,
          retryToolCallId: state.activeTool?.callId ?? null,
        },
        providerKind: state.metadata.providerKind,
        recoveryFailureMode: "recoverable",
      },
    ).catch((err) => {
      runStore.markRecoverable(runId);
      runStore.appendEvent(runId, {
        type: "run.recoverable",
        reason: "gateway_restarted",
        message: err instanceof Error ? err.message : String(err),
      });
    });
    return { status: "scheduled" };
  };

  const recoveryStatesByRunId = new Map<
    string,
    NonNullable<ReturnType<RunStore["getRecoveryState"]>>
  >();
  for (const run of runStore.listInflight()) {
    const state = runStore.getRecoveryState(run.id);
    if (state?.sdkState) recoveryStatesByRunId.set(run.id, state);
  }

  const startupRecovery = recoverInflightRuns({
    runs: runStore,
    hasApprovalInterruption: async (sdkState, runId) => {
      const state = recoveryStatesByRunId.get(runId);
      if (!state) return false;
      if (
        state.activeTool &&
        !runStore.hasTerminalToolEvent(state.metadata.runId, state.activeTool.callId)
      ) {
        return false;
      }
      try {
        const agent = new Agent<SdkRunContext>({
          name: "local-work",
          instructions: composeSystemPromptWithContext(
            state.metadata.systemPrompt,
            state.metadata.contextPrompt,
          ),
          model: state.metadata.model,
          tools: AGENT_TOOL_NAMES.map((toolName) => makeSdkTool(toolName)),
          modelSettings: { store: false },
        });
        return await sdkStateHasInterruptions({
          sdkState,
          agent,
          context: {
            runId: state.metadata.runId,
            workspacePath: state.metadata.workspacePath,
            toolCallable: tools,
            sdkApprovedToolCalls: new Map(),
          },
        });
      } catch {
        return false;
      }
    },
  })
    .then((recoveryActions) => {
      for (const action of recoveryActions) {
        if (action.kind === "auto_resume") resumeRun(action.runId, "auto");
      }
    })
    .catch((err) => {
      console.error("[gateway] startup recovery failed", err);
    });

  const app = new Hono();
  app.use("*", async (_c, next) => {
    await startupRecovery;
    return next();
  });
  app.use("*", errorBoundary);
  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      apiVersion: "v1",
      gatewayVersion: "0.1.0",
      uptimeMs: Math.round(process.uptime() * 1000),
    }),
  );
  app.use("*", originGuard, authMiddleware(cfg.token));

  app.route("/", profileRouter(profileStore));
  app.route("/", workspacesRouter(workspaceStore));
  app.route("/", agentsRouter(agentStore));
  app.route("/", skillsRouter(agentStore, cfg.profileDir));
  app.route(
    "/",
    mcpServersRouter({
      store: mcpServerStore,
      runtime: {
        status: (serverId) => mcpClientManager.status(serverId),
        reconnect: (serverId) => mcpClientManager.reconnect(serverId),
        tools: (serverId) => mcpClientManager.listTools(serverId),
      },
    }),
  );
  app.route(
    "/",
    memoriesRouter({ agents: agentStore, memories: memoryStore, memoryFiles: memoryFileStore, embed: embedMemoryText }),
  );
  app.route("/", attachmentsRouter(attachmentStore));
  app.route(
    "/",
    conversationsRouter({
      conversations: conversationStore,
      messages: messageStore,
      contexts: conversationContextStore,
    }),
  );
  app.route(
    "/",
    runsRouter({
      conversations: conversationStore,
      messages: messageStore,
      attachments: attachmentStore,
      runs: runStore,
      llm,
      noToolsLlm: contextCompactionLlm,
      tools,
      approvalQueue,
      cancelSignals,
      contexts: conversationContextStore,
      resumeRun,
      systemPromptForAgent,
      skillsPromptForAgent,
      memoryPromptForRun,
      afterRunSucceeded,
      modelForAgent,
      workspacePathForAgent,
    }),
  );

  return app;

  function agentForWorkspace(workspacePath: string) {
    const agent = agentStore.list().find((candidate) => candidate.workspace.path === workspacePath);
    if (!agent) throw new Error(`agent not found for workspace: ${workspacePath}`);
    return agent;
  }
}

function truncateMemorySnippet(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length <= 240 ? normalized : `${normalized.slice(0, 240)}...`;
}
