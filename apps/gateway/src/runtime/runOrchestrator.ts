import type { RunStore, PartialRunEvent, RunRecoveryMetadata } from "../domain/runStore";
import type { MessageStore } from "../domain/messageStore";
import type { ConversationStore } from "../domain/conversationStore";
import type { Session, SessionInputCallback } from "@openai/agents";
import {
  runConversation,
  type LlmAttachment,
  type LlmCallable,
  type LlmRecoveryInput,
  type ToolCallable,
} from "@vulture/agent-runtime";
import type { RunEvent } from "@vulture/protocol/src/v1/run";
import type { AppError } from "@vulture/protocol/src/v1/error";
import {
  tryEmitRuntimeHook,
  type RuntimeHookRunner,
  type RunLifecycleEvent,
} from "./runtimeHooks";

export interface OrchestratorDeps {
  runs: RunStore;
  messages: MessageStore;
  conversations: ConversationStore;
  llm: LlmCallable;
  tools: ToolCallable;
  cancelSignals: Map<string, AbortController>;
  runtimeHooks?: RuntimeHookRunner;
  afterRunSucceeded?: (input: {
    runId: string;
    conversationId: string;
    agentId: string;
    model: string;
    userInput: string;
    finalText: string;
    workspacePath: string;
    resultMessageId: string;
  }) => Promise<void> | void;
}

export interface OrchestrateArgs {
  runId: string;
  agentId: string;
  model: string;
  systemPrompt: string;
  contextPrompt?: string;
  conversationId: string;
  userInput: string;
  attachments?: LlmAttachment[];
  workspacePath: string;
  recovery?: LlmRecoveryInput;
  session?: Session;
  sessionInputCallback?: SessionInputCallback;
  providerKind?: RunRecoveryMetadata["providerKind"];
  recoveryFailureMode?: "recoverable";
}

export async function orchestrateRun(deps: OrchestratorDeps, args: OrchestrateArgs): Promise<void> {
  const ac = new AbortController();
  let completedFinalText: string | null = null;
  let modelStartedAt: number | null = null;
  let modelAfterCallEmitted = false;
  const lifecycleEvent = (): RunLifecycleEvent => ({
    runId: args.runId,
    conversationId: args.conversationId,
    agentId: args.agentId,
    model: args.model,
    workspacePath: args.workspacePath,
    recovery: Boolean(args.recovery),
  });
  deps.cancelSignals.set(args.runId, ac);
  try {
    if (deps.runtimeHooks) {
      await deps.runtimeHooks.emit("run.beforeStart", lifecycleEvent(), hookContext(args));
    }
    const recoveryMetadata: RunRecoveryMetadata = {
      runId: args.runId,
      conversationId: args.conversationId,
      agentId: args.agentId,
      model: args.model,
      systemPrompt: args.systemPrompt,
      contextPrompt: args.contextPrompt,
      userInput: args.userInput,
      workspacePath: args.workspacePath,
      providerKind: args.providerKind ?? "api_key",
      updatedAt: new Date().toISOString(),
    };
    const existingRecovery = deps.runs.getRecoveryState(args.runId);
    deps.runs.saveRecoveryState(args.runId, {
      schemaVersion: 1,
      sdkState: args.recovery?.sdkState ?? existingRecovery?.sdkState ?? null,
      metadata: existingRecovery?.metadata ?? recoveryMetadata,
      checkpointSeq: deps.runs.latestSeq(args.runId),
      activeTool: existingRecovery?.activeTool ?? null,
    });
    deps.runs.markRunning(args.runId);
    if (deps.runtimeHooks) {
      await deps.runtimeHooks.emit("run.afterStart", lifecycleEvent(), hookContext(args));
    }
    modelStartedAt = Date.now();
    if (deps.runtimeHooks) {
      await deps.runtimeHooks.emit(
        "model.beforeCall",
        {
          runId: args.runId,
          agentId: args.agentId,
          model: args.model,
          workspacePath: args.workspacePath,
        },
        hookContext(args),
      );
    }
    const result = await runConversation({
      runId: args.runId,
      agentId: args.agentId,
      model: args.model,
      systemPrompt: args.systemPrompt,
      contextPrompt: args.contextPrompt,
      userInput: args.userInput,
      attachments: args.attachments,
      workspacePath: args.workspacePath,
      llm: deps.llm,
      // Runtime hooks for tool calls live in sdkAdapter (the SDK execute path).
      // The SDK bypasses runner.args.tools, so any hook wiring here would only
      // fire for non-SDK LLM providers. Keeping a single trigger point avoids
      // double-emission and concentrates policy on the layer closest to actual
      // tool execution. Non-SDK providers that bypass the SDK must trigger
      // tool.beforeCall / tool.afterCall themselves.
      tools: deps.tools,
      recovery: args.recovery,
      session: args.session,
      sessionInputCallback: args.sessionInputCallback,
      onCheckpoint: (checkpoint) => {
        const previous = deps.runs.getRecoveryState(args.runId);
        const latestSeq = deps.runs.latestSeq(args.runId);
        const state = {
          schemaVersion: 1,
          sdkState: checkpoint.sdkState ?? previous?.sdkState ?? null,
          metadata: previous?.metadata ?? recoveryMetadata,
          checkpointSeq: latestSeq,
          activeTool: checkpoint.activeTool
            ? { ...checkpoint.activeTool, startedSeq: latestSeq }
            : null,
        };
        deps.runs.saveRecoveryState(args.runId, state);
        // onCheckpoint is a synchronous callback contract from the LLM; we
        // can't await here, but the helper still catches rejections so a
        // failing observation hook never escapes as unhandled.
        void tryEmitRuntimeHook(
          deps.runtimeHooks,
          "checkpoint.written",
          { runId: args.runId, checkpointSeq: latestSeq, checkpoint },
          hookContext(args),
        );
      },
      onEvent: (e: RunEvent) => {
        if (e.type === "run.completed") {
          completedFinalText = e.finalText;
          return;
        }
        if (e.type === "run.usage") {
          deps.runs.saveTokenUsage(args.runId, e.usage);
        }
        const appended = deps.runs.appendEvent(args.runId, stripBase(e));
        updateActiveToolSequence(deps, args.runId, appended);
      },
    });
    modelAfterCallEmitted = true;
    // model.afterCall is observation-only post-LLM. A misbehaving handler
    // must not flip the run from succeeded into the catch-block-failure path.
    await tryEmitRuntimeHook(
      deps.runtimeHooks,
      "model.afterCall",
      {
        runId: args.runId,
        agentId: args.agentId,
        model: args.model,
        workspacePath: args.workspacePath,
        outcome: result.status === "succeeded" ? "completed" : "error",
        durationMs: modelStartedAt === null ? 0 : Date.now() - modelStartedAt,
        error: result.error?.message,
      },
      hookContext(args),
    );

    if (deps.runs.get(args.runId)?.status === "cancelled") {
      deps.runs.clearRecoveryState(args.runId);
      return;
    }

    if (result.status === "succeeded") {
      if (result.usage) {
        deps.runs.saveTokenUsage(args.runId, result.usage);
      }
      const assistantMsg = deps.messages.append({
        conversationId: args.conversationId,
        role: "assistant",
        content: result.finalText,
        runId: args.runId,
      });
      deps.runs.markSucceeded(args.runId, assistantMsg.id);
      deps.conversations.touch(args.conversationId);
      await maybeGenerateTitle(deps, args, result.finalText);
      deps.runs.appendEvent(args.runId, {
        type: "run.completed",
        resultMessageId: assistantMsg.id,
        finalText: completedFinalText ?? result.finalText,
      });
      // Observation-only — must NOT delay orchestrator exit (callers depend
      // on afterRunSucceeded's sync prelude running before status flips
      // visible to test waiters). tryEmit catches all errors internally, so
      // fire-and-forget here is still safe.
      void tryEmitRuntimeHook(
        deps.runtimeHooks,
        "run.afterSuccess",
        {
          ...lifecycleEvent(),
          resultMessageId: assistantMsg.id,
          finalText: result.finalText,
          usage: result.usage,
        },
        hookContext(args),
      );
      void Promise.resolve(
        deps.afterRunSucceeded?.({
          runId: args.runId,
          conversationId: args.conversationId,
          agentId: args.agentId,
          model: args.model,
          userInput: args.userInput,
          finalText: result.finalText,
          workspacePath: args.workspacePath,
          resultMessageId: assistantMsg.id,
        }),
      ).catch((err) => {
        console.warn(
          "[gateway] memory suggestion extraction failed",
          err instanceof Error ? err.message : String(err),
        );
      });
    } else {
      const error = result.error ?? fallbackRunError("run failed without error");
      if (args.recoveryFailureMode === "recoverable") {
        if (isInvalidRecoveryStateError(error)) {
          deps.runs.markFailed(args.runId, error);
          await emitRunFailureHook(deps.runtimeHooks, args, lifecycleEvent(), error);
          deps.runs.clearRecoveryState(args.runId);
          return;
        }
        markRecoverableAfterResumeFailure(
          deps,
          args.runId,
          error.message,
        );
        return;
      }
      deps.runs.markFailed(args.runId, error);
      await emitRunFailureHook(deps.runtimeHooks, args, lifecycleEvent(), error);
    }
    deps.runs.clearRecoveryState(args.runId);
  } catch (err) {
    if (!modelAfterCallEmitted && modelStartedAt !== null) {
      await tryEmitRuntimeHook(
        deps.runtimeHooks,
        "model.afterCall",
        {
          runId: args.runId,
          agentId: args.agentId,
          model: args.model,
          workspacePath: args.workspacePath,
          outcome: "error",
          durationMs: Date.now() - modelStartedAt,
          error: err instanceof Error ? err.message : String(err),
        },
        hookContext(args),
      );
    }
    if (deps.runs.get(args.runId)?.status !== "cancelled") {
      if (args.recoveryFailureMode === "recoverable") {
        if (isInvalidRecoveryStateError(err)) {
          const error = fallbackRunError(err);
          deps.runs.markFailed(args.runId, error);
          await emitRunFailureHook(deps.runtimeHooks, args, lifecycleEvent(), error);
          deps.runs.clearRecoveryState(args.runId);
          return;
        }
        markRecoverableAfterResumeFailure(
          deps,
          args.runId,
          err instanceof Error ? err.message : String(err),
        );
        return;
      }
      const error = fallbackRunError(err);
      deps.runs.markFailed(args.runId, error);
      void emitRunFailureHook(deps.runtimeHooks, args, lifecycleEvent(), error);
    }
    deps.runs.clearRecoveryState(args.runId);
  } finally {
    deps.cancelSignals.delete(args.runId);
  }
}

function hookContext(args: OrchestrateArgs) {
  return {
    runId: args.runId,
    conversationId: args.conversationId,
    agentId: args.agentId,
    model: args.model,
    workspacePath: args.workspacePath,
  };
}

async function emitRunFailureHook(
  hooks: RuntimeHookRunner | undefined,
  args: OrchestrateArgs,
  lifecycle: RunLifecycleEvent,
  error: AppError,
): Promise<void> {
  // Failure-path emits cannot propagate hook errors back to the caller —
  // the run has already been marked failed; we only need observability.
  await tryEmitRuntimeHook(hooks, "run.afterFailure", { ...lifecycle, error }, hookContext(args));
}

function markRecoverableAfterResumeFailure(
  deps: OrchestratorDeps,
  runId: string,
  message: string,
): void {
  deps.runs.markRecoverable(runId);
  deps.runs.appendEvent(runId, {
    type: "run.recoverable",
    reason: "gateway_restarted",
    message,
  });
}

function updateActiveToolSequence(
  deps: OrchestratorDeps,
  runId: string,
  event: RunEvent,
): void {
  if (event.type !== "tool.planned" && event.type !== "tool.started") return;
  const previous = deps.runs.getRecoveryState(runId);
  if (!previous?.activeTool || previous.activeTool.callId !== event.callId) return;
  deps.runs.saveRecoveryState(runId, {
    ...previous,
    checkpointSeq: event.seq,
    activeTool: {
      ...previous.activeTool,
      startedSeq: event.seq,
    },
  });
}

function fallbackRunError(cause: unknown): AppError {
  return {
    code: "internal",
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

function isInvalidRecoveryStateError(cause: unknown): boolean {
  if (!cause) return false;
  if (typeof cause === "object" && "message" in cause) {
    const message = (cause as { message?: unknown }).message;
    return typeof message === "string" && message.includes("internal.recovery_state_invalid");
  }
  return String(cause).includes("internal.recovery_state_invalid");
}

async function maybeGenerateTitle(
  deps: OrchestratorDeps,
  args: OrchestrateArgs,
  finalText: string,
): Promise<void> {
  const current = deps.conversations.get(args.conversationId);
  if (!current) return;
  const provisional = args.userInput.slice(0, 40);
  if (current.title !== provisional) return;
  if (isConfigurationFallback(finalText)) return;

  const title = await generateConversationTitle(deps.llm, args, finalText).catch(() => null);
  if (!title) return;
  deps.conversations.updateTitle(args.conversationId, title);
}

async function generateConversationTitle(
  llm: LlmCallable,
  args: OrchestrateArgs,
  finalText: string,
): Promise<string | null> {
  let text = "";
  const input = [
    "User message:",
    args.userInput,
    "",
    "Assistant response:",
    finalText.slice(0, 1200),
  ].join("\n");
  for await (const y of llm({
    runId: `${args.runId}:title`,
    model: args.model,
    systemPrompt:
      "Generate a concise conversation title. Return only the title, no quotes, no punctuation-only output, maximum 6 words.",
    userInput: input,
    workspacePath: args.workspacePath,
  })) {
    if (y.kind === "text.delta") text += y.text;
    if (y.kind === "final") text = y.text || text;
    if (y.kind === "tool.plan" || y.kind === "await.tool") return null;
  }
  return sanitizeTitle(text);
}

function sanitizeTitle(raw: string): string | null {
  const singleLine = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!singleLine) return null;
  const compact = singleLine.replace(/\s+/g, " ").slice(0, 60).trim();
  return compact.length > 0 ? compact : null;
}

function isConfigurationFallback(text: string): boolean {
  return (
    text.includes("OPENAI_API_KEY not configured") ||
    text.includes("Codex 已过期")
  );
}

function stripBase(e: RunEvent): PartialRunEvent {
  const { runId: _r, seq: _s, createdAt: _c, ...rest } = e as RunEvent & {
    runId: string; seq: number; createdAt: string;
  };
  return rest as PartialRunEvent;
}
