import type { RunEvent } from "@vulture/protocol/src/v1/run";
import type { AppError } from "@vulture/protocol/src/v1/error";
import { nowIso8601 } from "@vulture/protocol/src/v1/index";

export class ToolCallError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "ToolCallError";
  }
}
import {
  runStarted,
  textDelta,
  toolPlanned,
  toolStarted,
  toolCompleted,
  toolFailed,
  runCompleted,
  runFailed,
} from "./events";

export type LlmYield =
  | { kind: "text.delta"; text: string }
  | { kind: "tool.plan"; callId: string; tool: string; input: unknown }
  | { kind: "await.tool"; callId: string }
  | { kind: "final"; text: string };

export type LlmCallable = (input: {
  systemPrompt: string;
  userInput: string;
  model: string;
  runId: string;
  workspacePath: string;
}) => AsyncGenerator<LlmYield, void, unknown>;

export type ToolCallable = (call: {
  callId: string;
  tool: string;
  input: unknown;
  runId: string;
  workspacePath: string;
}) => Promise<unknown>;

export interface RunConversationArgs {
  runId: string;
  agentId: string;
  model: string;
  systemPrompt: string;
  userInput: string;
  workspacePath: string;
  llm: LlmCallable;
  tools: ToolCallable;
  onEvent: (e: RunEvent) => void;
  idleTimeoutMs?: number;
}

export interface RunConversationResult {
  status: "succeeded" | "failed";
  finalText: string;
  error?: AppError;
}

export async function runConversation(
  args: RunConversationArgs,
): Promise<RunConversationResult> {
  let nextSeq = 0;
  const base = () => ({ runId: args.runId, seq: nextSeq++, createdAt: nowIso8601() });
  const emit = (e: RunEvent) => args.onEvent(e);
  emit(runStarted(base(), { agentId: args.agentId, model: args.model }));

  // Track callId -> { tool, input } so await.tool can look up details
  const pendingTools = new Map<string, { tool: string; input: unknown }>();

  let assembled = "";
  let gen: AsyncGenerator<LlmYield, void, unknown> | undefined;
  const idleTimeoutMs = args.idleTimeoutMs ?? 180_000;
  try {
    gen = args.llm({
      systemPrompt: args.systemPrompt,
      userInput: args.userInput,
      model: args.model,
      runId: args.runId,
      workspacePath: args.workspacePath,
    });

    let next: IteratorResult<LlmYield, void> | null = await withIdleTimeout(
      () => gen!.next(),
      idleTimeoutMs,
    );
    while (next && !next.done) {
      const y = next.value;
      switch (y.kind) {
        case "text.delta":
          assembled += y.text;
          emit(textDelta(base(), { text: y.text }));
          next = await withIdleTimeout(() => gen!.next(), idleTimeoutMs);
          break;
        case "tool.plan":
          pendingTools.set(y.callId, { tool: y.tool, input: y.input });
          emit(toolPlanned(base(), { callId: y.callId, tool: y.tool, input: y.input }));
          next = await withIdleTimeout(() => gen!.next(), idleTimeoutMs);
          break;
        case "await.tool": {
          emit(toolStarted(base(), { callId: y.callId }));
          const planned = pendingTools.get(y.callId);
          let result: unknown;
          try {
            try {
              result = await args.tools({
                callId: y.callId,
                tool: planned?.tool ?? "(unknown)",
                input: planned?.input ?? undefined,
                runId: args.runId,
                workspacePath: args.workspacePath,
              });
              emit(toolCompleted(base(), { callId: y.callId, output: result }));
            } catch (err) {
              const code =
                err instanceof ToolCallError
                  ? (err.code as AppError["code"])
                  : "tool.execution_failed";
              const error: AppError = {
                code,
                message: err instanceof Error ? err.message : String(err),
              };
              emit(toolFailed(base(), { callId: y.callId, error }));
              throw err;
            }
          } finally {
            pendingTools.delete(y.callId);
          }
          next = await withIdleTimeout(() => gen!.next(result), idleTimeoutMs);
          break;
        }
        case "final":
          if (y.text.length > 0) {
            assembled = y.text;
          }
          next = null;
          break;
      }
    }

    emit(
      runCompleted(base(), {
        resultMessageId: "pending",
        finalText: assembled,
      }),
    );
    return { status: "succeeded", finalText: assembled };
  } catch (err) {
    void gen?.return?.().catch(() => undefined);
    const error: AppError = {
      code: "internal",
      message: err instanceof Error ? err.message : String(err),
    };
    emit(runFailed(base(), { error }));
    return { status: "failed", finalText: assembled, error };
  }
}

async function withIdleTimeout<T>(op: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      op(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`LLM stream idle timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
