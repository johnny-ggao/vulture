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
import { RunStore } from "./domain/runStore";
import { profileRouter } from "./routes/profile";
import { workspacesRouter } from "./routes/workspaces";
import { agentsRouter } from "./routes/agents";
import { conversationsRouter } from "./routes/conversations";
import { runsRouter, type ResumeRunResult } from "./routes/runs";
import {
  assembleAgentInstructions,
  type ToolCallable,
} from "@vulture/agent-runtime";
import { selectModel } from "@vulture/llm";
import { AGENT_TOOL_NAMES } from "@vulture/protocol/src/v1/agent";
import { ApprovalQueue } from "./runtime/approvalQueue";
import { makeShellApprovalHandler, makeShellCallbackTools } from "./runtime/shellCallbackTools";
import { makeLazyLlm } from "./runtime/resolveLlm";
import { orchestrateRun } from "./runtime/runOrchestrator";
import { recoverInflightRuns } from "./runtime/runRecovery";
import { makeSdkTool, sdkStateHasInterruptions, type SdkRunContext } from "./runtime/openaiLlm";

export function buildServer(cfg: GatewayConfig): Hono {
  const dbPath = join(cfg.profileDir, "data.sqlite");
  const db = openDatabase(dbPath);
  applyMigrations(db);

  const importResult = importLegacy({ profileDir: cfg.profileDir, db });
  if (importResult.agentsImported || importResult.workspacesImported) {
    console.log(
      `[gateway] migrated ${importResult.agentsImported} agents + ${importResult.workspacesImported} workspaces from legacy file store`,
    );
  }

  const profileStore = new ProfileStore(db);
  const workspaceStore = new WorkspaceStore(db);
  const agentStore = new AgentStore(db, cfg.profileDir);
  const conversationStore = new ConversationStore(db);
  const messageStore = new MessageStore(db);
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

  const tools: ToolCallable = makeShellCallbackTools({
    callbackUrl: cfg.shellCallbackUrl,
    token: cfg.token,
    appendEvent: (runId, partial) => runStore.appendEvent(runId, partial),
    approvalQueue,
    cancelSignals,
    interactiveApprovalFallback: false,
  });
  const approvalCallable = makeShellApprovalHandler({
    callbackUrl: cfg.shellCallbackUrl,
    token: cfg.token,
    appendEvent: (runId, partial) => runStore.appendEvent(runId, partial),
    approvalQueue,
    cancelSignals,
  });

  const llm = makeLazyLlm({
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
      runs: runStore,
      llm,
      tools,
      approvalQueue,
      cancelSignals,
      resumeRun,
      systemPromptForAgent: ({ id }) => {
        const agent = agentStore.get(id);
        if (!agent) return "";
        return assembleAgentInstructions({
          packDir: join(packDir, "local-work"),
          agent: {
            id: agent.id,
            name: agent.name,
            description: agent.description,
            model: agent.model,
            reasoning: agent.reasoning,
            tools: agent.tools,
            instructions: agent.instructions,
          },
          workspace: {
            id: agent.workspace.id,
            name: agent.workspace.name,
            path: agent.workspace.path,
          },
        });
      },
      modelForAgent: ({ id }) => selectModel(agentStore.get(id)?.model ?? ""),
      workspacePathForAgent: ({ id }) => agentStore.get(id)?.workspace.path ?? "",
    }),
  );

  return app;
}
