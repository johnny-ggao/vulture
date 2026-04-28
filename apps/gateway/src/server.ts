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
import { profileRouter } from "./routes/profile";
import { workspacesRouter } from "./routes/workspaces";
import { agentsRouter } from "./routes/agents";
import { conversationsRouter } from "./routes/conversations";
import { runsRouter, type ResumeRunResult } from "./routes/runs";
import { attachmentsRouter } from "./routes/attachments";
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
import { makeSdkTool, sdkStateHasInterruptions, type SdkRunContext } from "./runtime/openaiLlm";
import { filterSkillEntries, formatSkillsForPrompt, loadSkillEntries } from "./runtime/skills";

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
  const startConversationRun = (conversationId: string, input: string) => {
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
      },
      {
        runId: run.id,
        agentId: conv.agentId,
        model: modelForAgent({ id: conv.agentId }),
        systemPrompt: systemPromptForAgent({ id: conv.agentId }),
        contextPrompt: skillsPromptForAgent({ id: conv.agentId }),
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
          return { ...startConversationRun(conversation.id, value.message), conversation };
        }
        return { conversation, runId: null };
      },
      yield: () => ({
        activeRuns: conversationStore
          .list()
          .flatMap((conversation) => runStore.listForConversation(conversation.id, { status: "active" })),
      }),
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
    shellCallbackUrl: cfg.shellCallbackUrl,
    shellToken: cfg.token,
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
          instructions: state.metadata.systemPrompt,
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
  app.route("/", attachmentsRouter(attachmentStore));
  app.route(
    "/",
    conversationsRouter({
      conversations: conversationStore,
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
      tools,
      approvalQueue,
      cancelSignals,
      resumeRun,
      systemPromptForAgent,
      skillsPromptForAgent,
      modelForAgent,
      workspacePathForAgent,
    }),
  );

  return app;
}
