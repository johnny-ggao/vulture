import type { LlmCheckpoint } from "@vulture/agent-runtime";
import type { AppError } from "@vulture/protocol/src/v1/error";
import type { TokenUsage } from "@vulture/protocol/src/v1/run";

export type RuntimeHookName =
  | "run.beforeStart"
  | "run.afterStart"
  | "model.beforeCall"
  | "model.afterCall"
  | "tool.beforeCall"
  | "tool.afterCall"
  | "approval.required"
  | "approval.resolved"
  | "checkpoint.written"
  | "context.beforeCompact"
  | "context.afterCompact"
  | "run.afterSuccess"
  | "run.afterFailure"
  | "subagent.beforeSpawn"
  | "subagent.afterEnd";

export interface RuntimeHookContext {
  runId?: string;
  conversationId?: string;
  agentId?: string;
  model?: string;
  workspacePath?: string;
}

export interface RuntimeHookEventMap {
  "run.beforeStart": RunLifecycleEvent;
  "run.afterStart": RunLifecycleEvent;
  "model.beforeCall": ModelBeforeCallEvent;
  "model.afterCall": ModelAfterCallEvent;
  "tool.beforeCall": ToolBeforeCallEvent;
  "tool.afterCall": ToolAfterCallEvent;
  "approval.required": ApprovalRequiredEvent;
  "approval.resolved": ApprovalResolvedEvent;
  "checkpoint.written": CheckpointWrittenEvent;
  "context.beforeCompact": ContextCompactEvent;
  "context.afterCompact": ContextCompactEvent;
  "run.afterSuccess": RunSuccessEvent;
  "run.afterFailure": RunFailureEvent;
  "subagent.beforeSpawn": SubagentBeforeSpawnEvent;
  "subagent.afterEnd": SubagentAfterEndEvent;
}

export interface RuntimeHookResultMap {
  "tool.beforeCall": ToolBeforeCallResult;
}

export interface RunLifecycleEvent {
  runId: string;
  conversationId: string;
  agentId: string;
  model: string;
  workspacePath: string;
  recovery: boolean;
}

export interface ModelBeforeCallEvent {
  runId: string;
  agentId: string;
  model: string;
  workspacePath: string;
}

export interface ModelAfterCallEvent extends ModelBeforeCallEvent {
  outcome: "completed" | "error";
  durationMs: number;
  error?: string;
}

export interface ToolBeforeCallEvent {
  runId: string;
  workspacePath: string;
  callId: string;
  toolId: string;
  category?: string;
  idempotent?: boolean;
  input: unknown;
}

export interface ToolBeforeCallResult {
  input?: unknown;
  block?: boolean;
  blockReason?: string;
}

export interface ToolBeforeCallDecision {
  blocked: boolean;
  input: unknown;
  reason?: string;
}

export interface ToolAfterCallEvent extends Omit<ToolBeforeCallEvent, "input"> {
  input: unknown;
  outcome: "completed" | "error" | "blocked";
  durationMs: number;
  output?: unknown;
  error?: string;
}

export interface ApprovalRequiredEvent {
  runId: string;
  callId: string;
  toolId: string;
  reason: string;
}

export interface ApprovalResolvedEvent extends ApprovalRequiredEvent {
  decision: "allow" | "deny";
}

export interface CheckpointWrittenEvent {
  runId: string;
  checkpointSeq: number;
  checkpoint: LlmCheckpoint;
}

export interface ContextCompactEvent {
  conversationId: string;
  agentId: string;
  runId?: string;
}

export interface RunSuccessEvent extends RunLifecycleEvent {
  resultMessageId: string;
  finalText: string;
  usage?: TokenUsage;
}

export interface RunFailureEvent extends RunLifecycleEvent {
  error: AppError;
}

export interface SubagentBeforeSpawnEvent {
  parentRunId: string;
  parentConversationId: string;
  agentId: string;
  label: string;
  message?: string;
}

export interface SubagentAfterEndEvent {
  parentRunId: string;
  sessionId: string;
  status: "completed" | "failed" | "cancelled";
}

export type RuntimeHookHandler<K extends RuntimeHookName> = (
  event: RuntimeHookEventMap[K],
  context: RuntimeHookContext,
) => K extends keyof RuntimeHookResultMap
  ? RuntimeHookResultMap[K] | void | Promise<RuntimeHookResultMap[K] | void>
  : void | Promise<void>;

export type RuntimeHookRegistration = {
  [K in RuntimeHookName]: {
    name: K;
    handler: RuntimeHookHandler<K>;
    priority?: number;
    timeoutMs?: number;
    failurePolicy?: "fail-open" | "fail-closed";
  };
}[RuntimeHookName];

interface RuntimeHookRegistrationBase {
  name: RuntimeHookName;
  priority?: number;
  timeoutMs?: number;
  failurePolicy?: "fail-open" | "fail-closed";
}

export interface RuntimeHookRunner {
  hasHooks(name: RuntimeHookName): boolean;
  emit<K extends RuntimeHookName>(
    name: K,
    event: RuntimeHookEventMap[K],
    context?: RuntimeHookContext,
  ): Promise<void>;
  runToolBeforeCall(
    event: ToolBeforeCallEvent,
    context?: RuntimeHookContext,
  ): Promise<ToolBeforeCallDecision>;
}

export interface RuntimeHookRunnerOptions {
  logger?: Pick<Console, "warn" | "error">;
}

const DEFAULT_HOOK_TIMEOUT_MS = 15_000;

export function createRuntimeHookRunner(
  registrations: readonly RuntimeHookRegistration[] = [],
  opts: RuntimeHookRunnerOptions = {},
): RuntimeHookRunner {
  const logger = opts.logger ?? console;
  const hooks = registrations.slice().sort(byPriorityDescending);

  function getHooks<K extends RuntimeHookName>(name: K): Extract<RuntimeHookRegistration, { name: K }>[] {
    return hooks.filter((hook) => hook.name === name) as unknown as Extract<
      RuntimeHookRegistration,
      { name: K }
    >[];
  }

  async function runWithTimeout<T>(hook: RuntimeHookRegistrationBase, task: () => Promise<T>): Promise<T> {
    const timeoutMs = positiveTimeout(hook.timeoutMs) ?? DEFAULT_HOOK_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        task(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`runtime hook timed out after ${timeoutMs}ms`));
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function emit<K extends RuntimeHookName>(
    name: K,
    event: RuntimeHookEventMap[K],
    context: RuntimeHookContext = {},
  ): Promise<void> {
    await Promise.all(
      getHooks(name).map(async (hook) => {
        try {
          await runWithTimeout(hook, async () => {
            const handler = hook.handler as (
              event: RuntimeHookEventMap[K],
              context: RuntimeHookContext,
            ) => unknown;
            await handler(event, context);
          });
        } catch (err) {
          logger.warn?.(`[runtime-hooks] ${name} hook failed: ${errorMessage(err)}`);
          if (hook.failurePolicy === "fail-closed") throw err;
        }
      }),
    );
  }

  async function runToolBeforeCall(
    event: ToolBeforeCallEvent,
    context: RuntimeHookContext = {},
  ): Promise<ToolBeforeCallDecision> {
    let input = event.input;
    for (const hook of getHooks("tool.beforeCall")) {
      try {
        const result = await runWithTimeout(hook, async () =>
          hook.handler({ ...event, input }, context),
        );
        if (!result) continue;
        if (Object.prototype.hasOwnProperty.call(result, "input")) {
          input = result.input;
        }
        if (result.block === true) {
          return {
            blocked: true,
            input,
            reason: result.blockReason || "Tool call blocked by runtime hook",
          };
        }
      } catch (err) {
        const reason = `Tool call blocked because runtime hook failed: ${errorMessage(err)}`;
        if (hook.failurePolicy === "fail-open") {
          logger.warn?.(`[runtime-hooks] tool.beforeCall hook failed: ${errorMessage(err)}`);
          continue;
        }
        return { blocked: true, input, reason };
      }
    }
    return { blocked: false, input };
  }

  return {
    hasHooks: (name) => getHooks(name).length > 0,
    emit,
    runToolBeforeCall,
  };
}

function byPriorityDescending(left: RuntimeHookRegistrationBase, right: RuntimeHookRegistrationBase): number {
  return (right.priority ?? 0) - (left.priority ?? 0);
}

function positiveTimeout(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
