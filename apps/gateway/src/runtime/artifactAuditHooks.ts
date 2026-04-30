import type { ArtifactStore, CreateArtifactInput } from "../domain/artifactStore";
import type { RunStore } from "../domain/runStore";
import type {
  RuntimeHookRegistration,
  RunSuccessEvent,
  ToolAfterCallEvent,
} from "./runtimeHooks";

export interface ArtifactAuditHookDeps {
  artifacts: ArtifactStore;
  runs: RunStore;
}

const TOOL_OUTPUT_PREVIEW_BYTES = 4096;
const RUN_FINAL_TEXT_PREVIEW_BYTES = 16_384;

/**
 * Two complementary hooks: one indexes successful tool outputs as artifacts so
 * the run trace can replay the result later; the other persists the run's
 * final assistant text as a "text" artifact for downstream consumers.
 *
 * Logging-only — neither hook can block. Errors are caught by the runner per
 * the default fail-open policy.
 */
export function makeArtifactAuditHooks(
  deps: ArtifactAuditHookDeps,
): readonly RuntimeHookRegistration[] {
  return [
    {
      name: "tool.afterCall",
      handler: (event) => recordToolOutput(deps, event),
    },
    {
      name: "run.afterSuccess",
      handler: (event) => recordRunFinalText(deps, event),
    },
  ];
}

function recordToolOutput(deps: ArtifactAuditHookDeps, event: ToolAfterCallEvent): void {
  if (event.outcome !== "completed") return;
  const run = deps.runs.get(event.runId);
  if (!run) return;
  const preview = previewOutput(event.output);
  if (!preview) return;
  const input: CreateArtifactInput = {
    runId: event.runId,
    conversationId: run.conversationId,
    agentId: run.agentId,
    kind: "data",
    title: `${event.toolId}:${event.callId}`,
    mimeType: "application/json",
    content: preview,
    metadata: {
      callId: event.callId,
      toolId: event.toolId,
      category: event.category ?? null,
      idempotent: event.idempotent ?? null,
      durationMs: event.durationMs,
    },
  };
  deps.artifacts.create(input);
}

function recordRunFinalText(deps: ArtifactAuditHookDeps, event: RunSuccessEvent): void {
  const text = event.finalText.trim();
  if (!text) return;
  const truncated =
    text.length > RUN_FINAL_TEXT_PREVIEW_BYTES
      ? `${text.slice(0, RUN_FINAL_TEXT_PREVIEW_BYTES)}…`
      : text;
  deps.artifacts.create({
    runId: event.runId,
    conversationId: event.conversationId,
    agentId: event.agentId,
    kind: "text",
    title: `run:${event.runId}:final`,
    mimeType: "text/plain",
    content: truncated,
    metadata: {
      resultMessageId: event.resultMessageId,
      model: event.model,
      usage: event.usage ?? null,
    },
  });
}

function previewOutput(output: unknown): string | null {
  if (output === undefined || output === null) return null;
  if (typeof output === "string") {
    return output.length > TOOL_OUTPUT_PREVIEW_BYTES
      ? `${output.slice(0, TOOL_OUTPUT_PREVIEW_BYTES)}…`
      : output;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(output);
  } catch {
    return null;
  }
  if (!serialized || serialized === "{}" || serialized === "[]") return null;
  return serialized.length > TOOL_OUTPUT_PREVIEW_BYTES
    ? `${serialized.slice(0, TOOL_OUTPUT_PREVIEW_BYTES)}…`
    : serialized;
}
