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
  /**
   * Default failure policy per hook name. Used when a registration does not
   * declare its own `failurePolicy`. Without an entry here, the
   * built-in default (`DEFAULT_FAILURE_POLICY_BY_HOOK`) decides.
   */
  defaultFailurePolicyByHook?: Partial<Record<RuntimeHookName, "fail-open" | "fail-closed">>;
  /**
   * Default per-hook-name timeout. Falls back to `DEFAULT_HOOK_TIMEOUT_MS`.
   */
  defaultTimeoutMsByHook?: Partial<Record<RuntimeHookName, number>>;
}

const DEFAULT_HOOK_TIMEOUT_MS = 15_000;

/**
 * Built-in failure-policy defaults. tool.beforeCall is the lone fail-closed
 * default — a missing/buggy policy hook must NOT silently allow tool calls.
 * Everything else defaults to fail-open so observation hooks can never break
 * the run loop.
 */
const DEFAULT_FAILURE_POLICY_BY_HOOK: Partial<
  Record<RuntimeHookName, "fail-open" | "fail-closed">
> = {
  "tool.beforeCall": "fail-closed",
};

type HooksByName = {
  [K in RuntimeHookName]?: ReadonlyArray<Extract<RuntimeHookRegistration, { name: K }>>;
};

function indexByName(registrations: readonly RuntimeHookRegistration[]): HooksByName {
  const buckets = new Map<RuntimeHookName, RuntimeHookRegistration[]>();
  for (const registration of registrations) {
    const existing = buckets.get(registration.name);
    if (existing) {
      existing.push(registration);
    } else {
      buckets.set(registration.name, [registration]);
    }
  }
  const result: HooksByName = {};
  for (const [name, group] of buckets) {
    group.sort(byPriorityDescending);
    // Cast is safe: `group` was built from registrations where every entry has
    // `name === <name>`, so the runtime narrows to the discriminated branch.
    (result as Record<string, ReadonlyArray<RuntimeHookRegistration>>)[name] = group;
  }
  return result;
}

const EMPTY_HOOKS: ReadonlyArray<never> = Object.freeze([]);

export function createRuntimeHookRunner(
  registrations: readonly RuntimeHookRegistration[] = [],
  opts: RuntimeHookRunnerOptions = {},
): RuntimeHookRunner {
  const logger = opts.logger ?? console;
  const hooksByName = indexByName(registrations);
  const failurePolicyDefaults = {
    ...DEFAULT_FAILURE_POLICY_BY_HOOK,
    ...opts.defaultFailurePolicyByHook,
  };
  const timeoutDefaults = opts.defaultTimeoutMsByHook ?? {};

  function getHooks<K extends RuntimeHookName>(
    name: K,
  ): ReadonlyArray<Extract<RuntimeHookRegistration, { name: K }>> {
    return hooksByName[name] ?? (EMPTY_HOOKS as ReadonlyArray<Extract<RuntimeHookRegistration, { name: K }>>);
  }

  function resolveFailurePolicy(hook: RuntimeHookRegistrationBase): "fail-open" | "fail-closed" {
    if (hook.failurePolicy) return hook.failurePolicy;
    return failurePolicyDefaults[hook.name] ?? "fail-open";
  }

  async function runWithTimeout<T>(hook: RuntimeHookRegistrationBase, task: () => Promise<T>): Promise<T> {
    const timeoutMs =
      positiveTimeout(hook.timeoutMs) ??
      positiveTimeout(timeoutDefaults[hook.name]) ??
      DEFAULT_HOOK_TIMEOUT_MS;
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
          if (resolveFailurePolicy(hook) === "fail-closed") throw err;
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
        if (resolveFailurePolicy(hook) === "fail-open") {
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

/**
 * Emit a runtime hook from a position that must NOT propagate hook failures
 * (catch blocks, post-finalize lifecycle, sync callbacks). Awaits the emit
 * and logs any error; never re-throws. fail-closed handlers still surface in
 * logs but won't derail an already-decided run status. Use plain `emit` when
 * the caller intentionally wants fail-closed behaviour (pre-flight gates).
 */
export async function tryEmitRuntimeHook<K extends RuntimeHookName>(
  hooks: RuntimeHookRunner | undefined,
  name: K,
  event: RuntimeHookEventMap[K],
  context: RuntimeHookContext = {},
  logger: Pick<Console, "warn"> = console,
): Promise<void> {
  if (!hooks) return;
  try {
    await hooks.emit(name, event, context);
  } catch (err) {
    logger.warn?.(
      `[runtime-hooks] ${name} hook failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
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
