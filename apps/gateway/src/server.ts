import { Hono } from "hono";
import { Agent } from "@openai/agents";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { authMiddleware, originGuard } from "./middleware/auth";
import { errorBoundary } from "./middleware/error";
import type { GatewayConfig } from "./env";
import {
  startConversationRun as startConversationRunWithContext,
  type ResumeRunResult,
} from "./routes/runs";
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
import { extractMemorySuggestions } from "./runtime/memorySuggestionExtractor";
import {
  composeSystemPromptWithContext,
  makeSdkTool,
  sdkStateHasInterruptions,
  type SdkRunContext,
} from "./runtime/openaiLlm";
import { filterSkillEntries, formatSkillsForPrompt, loadSkillEntries } from "./runtime/skills";
import { McpClientManager } from "./runtime/mcpClientManager";
import { createRuntimeHookRunner, tryEmitRuntimeHook } from "./runtime/runtimeHooks";
import { makePermissionPolicyHook } from "./runtime/permissionPolicyHook";
import { makeArtifactAuditHooks } from "./runtime/artifactAuditHooks";
import { createGatewayStores } from "./server/stores";
import { mountGatewayRoutes } from "./server/routes";
import { createGatewayServerLocalTools } from "./server/localTools";

// Resolve at module load. server.ts lives at apps/gateway/src/server.ts;
// `../builtin-skills/` lifts out of `src/` into `apps/gateway/builtin-skills/`.
const BUILTIN_SKILLS_DIR = fileURLToPath(new URL("../builtin-skills/", import.meta.url));

export function buildServer(cfg: GatewayConfig): Hono {
  // runtimeHooks is created below, but SubagentSessionStore needs to fire
  // subagent.afterEnd through it. Bind via late-set ref to break the cycle.
  let runtimeHooksRef: ReturnType<typeof createRuntimeHookRunner> | undefined;
  const { stores, importResult } = createGatewayStores({
    cfg,
    onSubagentStatusChange: ({ session }) => {
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
    },
  });
  if (importResult.agentsImported || importResult.workspacesImported) {
    console.log(
      `[gateway] migrated ${importResult.agentsImported} agents + ${importResult.workspacesImported} workspaces from legacy file store`,
    );
  }

  const {
    agentStore,
    conversationStore,
    messageStore,
    attachmentStore,
    runStore,
    conversationContextStore,
    mcpServerStore,
    permissionPolicyStore,
    artifactStore,
    memoryFileStore,
  } = stores;
  const runtimeHooks = createRuntimeHookRunner([
    makePermissionPolicyHook({
      policies: permissionPolicyStore,
      runs: runStore,
      conversations: conversationStore,
    }),
    ...makeArtifactAuditHooks({ artifacts: artifactStore, runs: runStore }),
  ]);
  runtimeHooksRef = runtimeHooks;
  const mcpClientManager = new McpClientManager(mcpServerStore);
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
  const permissionModeForRun = (runId: string) => {
    const run = runStore.get(runId);
    if (!run) return "default" as const;
    return conversationStore.get(run.conversationId)?.permissionMode ?? "default";
  };

  const shellTools: ToolCallable = makeShellCallbackTools({
    callbackUrl: cfg.shellCallbackUrl,
    token: cfg.token,
    appendEvent: (runId, partial) => runStore.appendEvent(runId, partial),
    approvalQueue,
    cancelSignals,
    interactiveApprovalFallback: false,
    runtimeHooks,
    permissionModeForRun,
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
      builtinDir: BUILTIN_SKILLS_DIR,
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
  tools = createGatewayServerLocalTools({
    stores,
    shellTools,
    mcp: {
      canHandle: (toolName) => mcpClientManager.canHandle(toolName),
      execute: (call) => mcpClientManager.executeToolCall(call),
    },
    lspManager: cfg.lspManager,
    runtimeHooks: () => runtimeHooksRef,
    startConversationRun,
  });
  const approvalCallable = makeShellApprovalHandler({
    callbackUrl: cfg.shellCallbackUrl,
    token: cfg.token,
    appendEvent: (runId, partial) => runStore.appendEvent(runId, partial),
    approvalQueue,
    cancelSignals,
    runtimeHooks,
    permissionModeForRun,
  });

  llm = cfg.llmOverride
    ? cfg.llmOverride
    : makeLazyLlm({
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
        permissionMode: conversationStore.get(state.metadata.conversationId)?.permissionMode,
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
    NonNullable<ReturnType<typeof runStore.getRecoveryState>>
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

  mountGatewayRoutes({
    app,
    cfg,
    stores,
    mcpClientManager,
    runRuntime: {
      llm,
      noToolsLlm: contextCompactionLlm,
      tools,
      approvalQueue,
      cancelSignals,
      runtimeHooks,
      resumeRun,
      systemPromptForAgent,
      skillsPromptForAgent,
      memoryPromptForRun,
      afterRunSucceeded,
      modelForAgent,
      workspacePathForAgent,
    },
  });

  return app;
}
