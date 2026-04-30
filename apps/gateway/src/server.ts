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
import { SubagentSessionStore } from "./domain/subagentSessionStore";
import { profileRouter } from "./routes/profile";
import { workspacesRouter } from "./routes/workspaces";
import { agentsRouter } from "./routes/agents";
import { skillsRouter } from "./routes/skills";
import { toolsRouter } from "./routes/tools";
import { memoriesRouter } from "./routes/memories";
import { conversationsRouter } from "./routes/conversations";
import { subagentSessionsRouter } from "./routes/subagentSessions";
import {
  runsRouter,
  startConversationRun as startConversationRunWithContext,
  type ResumeRunResult,
} from "./routes/runs";
import { attachmentsRouter } from "./routes/attachments";
import { mcpServersRouter } from "./routes/mcpServers";
import { skillCatalogRouter } from "./routes/skillCatalog";
import { permissionPoliciesRouter } from "./routes/permissionPolicies";
import { artifactsRouter } from "./routes/artifacts";
import { runTraceRouter } from "./routes/runTrace";
import { browserCapabilitiesRouter } from "./routes/browserCapabilities";
import { mcpProxyRouter } from "./routes/mcpProxy";
import { runtimeDiagnosticsRouter } from "./routes/runtimeDiagnostics";
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
import { SkillCatalogStore } from "./domain/skillCatalogStore";
import { PermissionPolicyStore } from "./domain/permissionPolicyStore";
import { ArtifactStore } from "./domain/artifactStore";
import { makeOpenAIEmbeddingProvider } from "./runtime/openaiEmbeddings";
import { McpClientManager } from "./runtime/mcpClientManager";
import { createRuntimeHookRunner, tryEmitRuntimeHook } from "./runtime/runtimeHooks";
import { makePermissionPolicyHook } from "./runtime/permissionPolicyHook";
import { makeArtifactAuditHooks } from "./runtime/artifactAuditHooks";

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
  // runtimeHooks is created below, but SubagentSessionStore needs to fire
  // subagent.afterEnd through it. Bind via late-set ref to break the cycle.
  let runtimeHooksRef: ReturnType<typeof createRuntimeHookRunner> | undefined;
  const subagentSessionStore = new SubagentSessionStore(db, {
    runs: runStore,
    messages: messageStore,
    onStatusChange: ({ session, previousStatus }) => {
      // Sync callback contract; we can't await but must not leak rejections.
      void tryEmitRuntimeHook(
        runtimeHooksRef,
        "subagent.afterEnd",
        {
          parentRunId: session.parentRunId,
          sessionId: session.id,
          status:
            session.status === "completed" || session.status === "failed" || session.status === "cancelled"
              ? session.status
              : "completed",
        },
        {
          runId: session.parentRunId,
          conversationId: session.parentConversationId,
          agentId: session.agentId,
        },
      );
      void previousStatus;
    },
  });
  const memoryStore = new MemoryStore(db);
  const mcpServerStore = new McpServerStore(db);
  const skillCatalogStore = new SkillCatalogStore(cfg.profileDir);
  const permissionPolicyStore = new PermissionPolicyStore(
    join(cfg.profileDir, "policies", "permission-policies.json"),
  );
  const artifactStore = new ArtifactStore(join(cfg.profileDir, "artifacts", "index.json"));
  const runtimeHooks = createRuntimeHookRunner([
    makePermissionPolicyHook({ policies: permissionPolicyStore, runs: runStore }),
    ...makeArtifactAuditHooks({ artifacts: artifactStore, runs: runStore }),
  ]);
  runtimeHooksRef = runtimeHooks;
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
    runtimeHooks,
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
        handoffs: agent.handoffAgentIds
          .map((handoffId) => agentStore.get(handoffId))
          .filter((handoff): handoff is NonNullable<typeof handoff> => Boolean(handoff))
          .filter((handoff) => handoff.id !== agent.id)
          .map((handoff) => ({
            id: handoff.id,
            name: handoff.name,
            description: handoff.description,
          })),
        model: agent.model,
        reasoning: agent.reasoning,
      },
      workspace: {
        id: agent.workspace.id,
        name: agent.workspace.name,
        path: agent.workspace.path,
      },
      agentCoreDir: agentStore.agentCorePath(agent.id),
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
      agentCoreDir: agentStore.agentCorePath(agent.id),
    });
    return formatSkillsForPrompt(filterSkillEntries(entries, agent.skills));
  };
  const memoryPromptForRun = async ({ agentId }: { agentId: string; input: string }): Promise<string> => {
    const agent = agentStore.get(agentId);
    return agent ? memoryFileStore.contextPrompt(agent) : "";
  };
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
    const result = await startConversationRunWithContext(
      {
        conversations: conversationStore,
        messages: messageStore,
        attachments: attachmentStore,
        runs: runStore,
        llm,
        noToolsLlm: contextCompactionLlm,
        tools,
        approvalQueue,
        cancelSignals,
        runtimeHooks,
        contexts: conversationContextStore,
        resumeRun,
        systemPromptForAgent,
        skillsPromptForAgent,
        memoryPromptForRun,
        afterRunSucceeded,
        modelForAgent,
        workspacePathForAgent,
      },
      { conversationId, input },
    );
    return { conversationId, runId: result.run.id, messageId: result.message.id };
  };
  tools = makeGatewayLocalTools({
    shellTools,
    appendEvent: (runId, partial) => runStore.appendEvent(runId, partial),
    mcp: {
      canHandle: (toolName) => mcpClientManager.canHandle(toolName),
      execute: (call) => mcpClientManager.executeToolCall(call),
    },
    sessions: {
      list: (call) => {
        const value = call.input as {
          parentConversationId?: unknown;
          parentRunId?: unknown;
          agentId?: unknown;
          limit?: unknown;
        };
        const currentRun = runStore.get(call.runId);
        const parentConversationId =
          typeof value.parentConversationId === "string"
            ? value.parentConversationId
            : typeof value.parentRunId === "string"
            ? undefined
            : currentRun?.conversationId;
        return subagentSessionStore.list({
          parentConversationId,
          parentRunId: typeof value.parentRunId === "string" ? value.parentRunId : undefined,
          agentId: typeof value.agentId === "string" ? value.agentId : undefined,
          limit: typeof value.limit === "number" ? value.limit : 20,
        });
      },
      history: (call) => {
        const value = call.input as { sessionId?: unknown; conversationId?: unknown; limit?: unknown };
        const session = typeof value.sessionId === "string"
          ? subagentSessionStore.get(value.sessionId)
          : null;
        const conversationId = session?.conversationId ??
          (typeof value.conversationId === "string" ? value.conversationId : null);
        if (!conversationId) {
          throw new Error("sessions_history requires sessionId or conversationId");
        }
        const limit = typeof value.limit === "number" ? value.limit : 50;
        const messages = messageStore.listSince({ conversationId });
        return messages.slice(-limit);
      },
      send: async (call) => {
        const value = call.input as { sessionId?: unknown; conversationId?: unknown; message?: unknown };
        const session = typeof value.sessionId === "string"
          ? subagentSessionStore.get(value.sessionId)
          : null;
        const conversationId = session?.conversationId ??
          (typeof value.conversationId === "string" ? value.conversationId : null);
        if (!conversationId || typeof value.message !== "string") {
          throw new Error("sessions_send requires sessionId or conversationId and message");
        }
        const result = await startConversationRun(conversationId, value.message);
        return {
          ...result,
          session: session ? subagentSessionStore.refreshStatus(session.id) : null,
        };
      },
      spawn: async (call) => {
        const value = call.input as {
          agentId?: unknown;
          title?: unknown;
          label?: unknown;
          message?: unknown;
        };
        const parentRun = runStore.get(call.runId);
        if (!parentRun) throw new Error(`parent run not found: ${call.runId}`);
        const agentId =
          typeof value.agentId === "string" && value.agentId.length > 0
            ? value.agentId
            : "local-work-agent";
        if (!agentStore.get(agentId)) throw new Error(`agent not found: ${agentId}`);
        const title = typeof value.title === "string" ? value.title : "";
        const conversation = conversationStore.create({
          agentId,
          title,
        });
        const label = subagentLabel(value, title, agentId);
        const session = subagentSessionStore.create({
          parentConversationId: parentRun.conversationId,
          parentRunId: parentRun.id,
          agentId,
          conversationId: conversation.id,
          label,
        });
        await tryEmitRuntimeHook(
          runtimeHooksRef,
          "subagent.beforeSpawn",
          {
            parentRunId: parentRun.id,
            parentConversationId: parentRun.conversationId,
            agentId,
            label,
            message: typeof value.message === "string" ? value.message : undefined,
          },
          {
            runId: parentRun.id,
            conversationId: parentRun.conversationId,
            agentId,
          },
        );
        if (typeof value.message === "string" && value.message.length > 0) {
          const run = await startConversationRun(conversation.id, value.message);
          return {
            ...run,
            conversation,
            session: subagentSessionStore.refreshStatus(session.id),
          };
        }
        return { conversation, runId: null, session };
      },
      yield: (call) => {
        const value = call.input as { parentConversationId?: unknown; parentRunId?: unknown; limit?: unknown };
        const parentRun = runStore.get(call.runId);
        const parentRunId = typeof value.parentRunId === "string" ? value.parentRunId : call.runId;
        const parentConversationId =
          typeof value.parentConversationId === "string"
            ? value.parentConversationId
            : parentRun?.conversationId;
        const sessions = subagentSessionStore.list({
          parentConversationId,
          parentRunId,
          limit: typeof value.limit === "number" ? value.limit : 20,
        });
        const items = sessions.map((session) => ({
          ...session,
          activeRuns: runStore.listForConversation(session.conversationId, { status: "active" }),
        }));
        return {
          items,
          activeRuns: items.flatMap((session) => session.activeRuns),
        };
      },
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
    runtimeHooks,
  });

  llm = makeLazyLlm({
    toolNames: AGENT_TOOL_NAMES,
    toolCallable: tools,
    approvalCallable,
    mcpToolProvider: () => mcpClientManager.getSdkToolsForRun(),
    runtimeHooks,
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
        runtimeHooks,
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
  app.route("/", toolsRouter());
  app.route("/", skillsRouter(agentStore, cfg.profileDir));
  app.route("/", skillCatalogRouter(skillCatalogStore));
  app.route("/", permissionPoliciesRouter(permissionPolicyStore));
  app.route("/", artifactsRouter(artifactStore));
  app.route("/", browserCapabilitiesRouter());
  app.route("/", mcpProxyRouter());
  app.route("/", runtimeDiagnosticsRouter());
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
    subagentSessionsRouter({
      sessions: subagentSessionStore,
      messages: messageStore,
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
  app.route(
    "/",
    runTraceRouter({
      runs: runStore,
      messages: messageStore,
      subagentSessions: subagentSessionStore,
      artifacts: artifactStore,
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

function subagentLabel(
  input: { label?: unknown; title?: unknown; message?: unknown },
  title: string,
  agentId: string,
): string {
  if (typeof input.label === "string" && input.label.trim()) return input.label.trim().slice(0, 80);
  if (title.trim()) return title.trim().slice(0, 80);
  if (typeof input.message === "string" && input.message.trim()) {
    return input.message.trim().replace(/\s+/g, " ").slice(0, 80);
  }
  return agentId;
}
