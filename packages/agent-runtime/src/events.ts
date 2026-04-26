import type { RunEvent } from "@vulture/protocol/src/v1/run";
import type { AppError } from "@vulture/protocol/src/v1/error";

interface Base {
  runId: string;
  seq: number;
  createdAt: string;
}

export function runStarted(base: Base, x: { agentId: string; model: string }): RunEvent {
  return { type: "run.started", ...base, ...x };
}
export function textDelta(base: Base, x: { text: string }): RunEvent {
  return { type: "text.delta", ...base, ...x };
}
export function toolPlanned(base: Base, x: { callId: string; tool: string; input: unknown }): RunEvent {
  return { type: "tool.planned", ...base, ...x };
}
export function toolStarted(base: Base, x: { callId: string }): RunEvent {
  return { type: "tool.started", ...base, ...x };
}
export function toolCompleted(base: Base, x: { callId: string; output: unknown }): RunEvent {
  return { type: "tool.completed", ...base, ...x };
}
export function toolFailed(base: Base, x: { callId: string; error: AppError }): RunEvent {
  return { type: "tool.failed", ...base, ...x };
}
export function toolAsk(base: Base, x: { callId: string; tool: string; reason: string; approvalToken: string }): RunEvent {
  return { type: "tool.ask", ...base, ...x };
}
export function runCompleted(base: Base, x: { resultMessageId: string; finalText: string }): RunEvent {
  return { type: "run.completed", ...base, ...x };
}
export function runFailed(base: Base, x: { error: AppError }): RunEvent {
  return { type: "run.failed", ...base, ...x };
}
export function runCancelled(base: Base): RunEvent {
  return { type: "run.cancelled", ...base };
}
