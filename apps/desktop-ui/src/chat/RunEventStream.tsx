import type { AnyRunEvent } from "../hooks/useRunStream";
import type { ApprovalDecision, TokenUsageDto } from "../api/runs";
import { MessageBubble } from "./MessageBubble";
import { ToolBlock, type ToolBlockStatus } from "./ToolBlock";
import { ApprovalCard } from "./ApprovalCard";
import { RecoveryCard } from "./RecoveryCard";
import { RunErrorCard } from "./RunErrorCard";

export type RunBlock =
  | { kind: "text"; content: string; firstSeq: number; usage?: TokenUsageDto }
  | { kind: "run-error"; message: string; code: string; firstSeq: number }
  | { kind: "recovery"; message: string; reason: string; firstSeq: number }
  | { kind: "recovery-boundary"; firstSeq: number }
  | {
      kind: "tool";
      callId: string;
      tool: string;
      input: unknown;
      status: ToolBlockStatus;
      output?: unknown;
      error?: { code: string; message: string };
      firstSeq: number;
    }
  | {
      kind: "approval";
      callId: string;
      tool: string;
      reason: string;
      /**
       * Snapshot of the tool input at ask time. The gateway may emit
       * `tool.planned` before `tool.ask` (with input populated) or send
       * input alongside `tool.ask`; we prefer ask's own input but fall
       * back to the planned-side snapshot when missing so the user
       * always sees what's about to run.
       */
      input?: unknown;
      approvalToken: string;
      firstSeq: number;
    };

export function reduceRunEvents(events: readonly AnyRunEvent[]): RunBlock[] {
  const blocks: Array<RunBlock | undefined> = [];
  const toolIndex = new Map<string, number>(); // callId -> blocks index
  const approvalIndex = new Map<string, number>(); // callId -> blocks index

  for (const e of events) {
    switch (e.type) {
      case "text.delta": {
        const last = blocks[blocks.length - 1];
        const piece = String(e.text ?? "");
        if (last && last.kind === "text") {
          blocks[blocks.length - 1] = { ...last, content: last.content + piece };
        } else {
          blocks.push({ kind: "text", content: piece, firstSeq: e.seq });
        }
        break;
      }
      case "tool.planned": {
        const callId = String(e.callId);
        const idx = blocks.length;
        toolIndex.set(callId, idx);
        blocks.push({
          kind: "tool",
          callId,
          tool: String(e.tool ?? ""),
          input: e.input,
          status: "planned",
          firstSeq: e.seq,
        });
        break;
      }
      case "tool.started": {
        const callId = String(e.callId);
        removeApprovalBlock(blocks, approvalIndex, callId);
        const idx = toolIndex.get(callId);
        const block = idx !== undefined ? blocks[idx] : undefined;
        if (idx !== undefined && block?.kind === "tool") {
          blocks[idx] = { ...block, status: "running" };
        }
        break;
      }
      case "tool.completed": {
        const callId = String(e.callId);
        removeApprovalBlock(blocks, approvalIndex, callId);
        const idx = toolIndex.get(callId);
        const block = idx !== undefined ? blocks[idx] : undefined;
        if (idx !== undefined && block?.kind === "tool") {
          blocks[idx] = { ...block, status: "completed", output: e.output };
        }
        break;
      }
      case "tool.failed": {
        const callId = String(e.callId);
        removeApprovalBlock(blocks, approvalIndex, callId);
        const idx = toolIndex.get(callId);
        const block = idx !== undefined ? blocks[idx] : undefined;
        if (idx !== undefined && block?.kind === "tool") {
          blocks[idx] = { ...block, status: "failed", error: e.error as { code: string; message: string } };
        } else {
          // No prior tool.planned (e.g. ask → deny path with no plan event):
          // synthesize a minimal failed block so the user still sees the error.
          blocks.push({
            kind: "tool",
            callId,
            tool: "(unknown)",
            input: undefined,
            status: "failed",
            error: e.error as { code: string; message: string },
            firstSeq: e.seq,
          });
        }
        break;
      }
      case "tool.ask": {
        const callId = String(e.callId);
        const idx = blocks.length;
        approvalIndex.set(callId, idx);
        // Prefer the ask payload's own input; fall back to whatever
        // tool.planned recorded if ask omitted it (some gateway versions
        // do that to avoid duplicating large argv on every event).
        const askInput = "input" in e && e.input !== undefined ? e.input : undefined;
        const plannedIdx = toolIndex.get(callId);
        const plannedBlock =
          plannedIdx !== undefined ? blocks[plannedIdx] : undefined;
        const plannedInput =
          plannedBlock?.kind === "tool" ? plannedBlock.input : undefined;
        blocks.push({
          kind: "approval",
          callId,
          tool: String(e.tool ?? ""),
          reason: String(e.reason ?? ""),
          input: askInput ?? plannedInput,
          approvalToken: String(e.approvalToken ?? ""),
          firstSeq: e.seq,
        });
        break;
      }
      case "run.recoverable": {
        blocks.push({
          kind: "recovery",
          message: String(e.message ?? "Run can be recovered."),
          reason: String(e.reason ?? ""),
          firstSeq: e.seq,
        });
        break;
      }
      case "run.recovered": {
        removeRecoveryBlocks(blocks);
        blocks.push({ kind: "recovery-boundary", firstSeq: e.seq });
        break;
      }
      case "run.failed": {
        const error = e.error as { code?: unknown; message?: unknown } | undefined;
        blocks.push({
          kind: "run-error",
          message: typeof error?.message === "string" ? error.message : "Run failed.",
          code: typeof error?.code === "string" ? error.code : "internal",
          firstSeq: e.seq,
        });
        break;
      }
      case "run.usage": {
        const usage = normalizeUsage(e.usage);
        if (!usage) break;
        const textBlock = findLastTextBlock(blocks);
        if (textBlock) {
          blocks[textBlock.index] = { ...textBlock.block, usage };
        }
        break;
      }
      // run.started / run.completed / run.cancelled produce no inline block
    }
  }

  return blocks.filter((block): block is RunBlock => block !== undefined);
}

function normalizeUsage(value: unknown): TokenUsageDto | null {
  const usage = value as Partial<TokenUsageDto> | undefined;
  if (
    typeof usage?.inputTokens !== "number" ||
    typeof usage.outputTokens !== "number" ||
    typeof usage.totalTokens !== "number"
  ) {
    return null;
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
  };
}

function findLastTextBlock(
  blocks: Array<RunBlock | undefined>,
): { index: number; block: Extract<RunBlock, { kind: "text" }> } | null {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block?.kind === "text") return { index: i, block };
  }
  return null;
}

function removeApprovalBlock(
  blocks: Array<RunBlock | undefined>,
  approvalIndex: Map<string, number>,
  callId: string,
): void {
  const idx = approvalIndex.get(callId);
  if (idx === undefined) return;
  blocks[idx] = undefined;
  approvalIndex.delete(callId);
}

export interface RunEventStreamProps {
  events: readonly AnyRunEvent[];
  submittingApprovals: ReadonlySet<string>;
  resuming: boolean;
  /**
   * True while the run is actively producing tokens. When set, the LAST
   * text block in the stream renders with a streaming caret so the user
   * sees output is in-flight.
   */
  streaming?: boolean;
  onDecide: (callId: string, decision: ApprovalDecision) => void;
  onResume: () => void;
  onCancel: () => void;
}

export function RunEventStream(props: RunEventStreamProps) {
  const blocks = reduceRunEvents(props.events);
  // Track the index of the latest text block so we can attach the caret
  // only there (and not to historical text blocks earlier in the stream).
  let lastTextIdx = -1;
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i]?.kind === "text") lastTextIdx = i;
  }
  return (
    <div className="run-event-stream">
      {blocks.map((b, i) => {
        if (b.kind === "text") {
          return (
            <MessageBubble
              key={i}
              role="assistant"
              content={b.content}
              usage={b.usage}
              streaming={Boolean(props.streaming) && i === lastTextIdx}
            />
          );
        }
        if (b.kind === "run-error") {
          return (
            <RunErrorCard
              key={`run-error-${b.firstSeq}`}
              code={b.code}
              message={b.message}
            />
          );
        }
        if (b.kind === "tool") {
          return (
            <ToolBlock
              key={`${b.callId}-${b.firstSeq}`}
              callId={b.callId}
              tool={b.tool}
              input={b.input}
              status={b.status}
              output={b.output}
              error={b.error}
            />
          );
        }
        if (b.kind === "recovery") {
          return (
            <RecoveryCard
              key={`recovery-${b.firstSeq}`}
              message={b.message}
              busy={props.resuming}
              onResume={props.onResume}
              onCancel={props.onCancel}
            />
          );
        }
        if (b.kind === "recovery-boundary") {
          return (
            <div key={`recovery-boundary-${b.firstSeq}`} className="recovery-boundary" role="separator">
              运行已恢复
            </div>
          );
        }
        return (
          <ApprovalCard
            key={`${b.callId}-${b.firstSeq}`}
            callId={b.callId}
            tool={b.tool}
            reason={b.reason}
            input={b.input}
            submitting={props.submittingApprovals.has(b.callId)}
            onDecide={props.onDecide}
          />
        );
      })}
    </div>
  );
}

function removeRecoveryBlocks(blocks: Array<RunBlock | undefined>): void {
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i]?.kind === "recovery") blocks[i] = undefined;
  }
}
