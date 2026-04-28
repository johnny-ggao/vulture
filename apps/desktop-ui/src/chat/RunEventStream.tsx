import type { AnyRunEvent } from "../hooks/useRunStream";
import type { ApprovalDecision } from "../api/runs";
import { MessageBubble } from "./MessageBubble";
import { ToolBlock, type ToolBlockStatus } from "./ToolBlock";
import { ApprovalCard } from "./ApprovalCard";
import { RecoveryCard } from "./RecoveryCard";

export type RunBlock =
  | { kind: "text"; content: string; firstSeq: number }
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
        blocks.push({
          kind: "approval",
          callId,
          tool: String(e.tool ?? ""),
          reason: String(e.reason ?? ""),
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
      // run.started / run.completed / run.failed / run.cancelled produce no inline block
    }
  }

  return blocks.filter((block): block is RunBlock => block !== undefined);
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
  onDecide: (callId: string, decision: ApprovalDecision) => void;
  onResume: () => void;
  onCancel: () => void;
}

export function RunEventStream(props: RunEventStreamProps) {
  const blocks = reduceRunEvents(props.events);
  return (
    <div className="run-event-stream">
      {blocks.map((b, i) => {
        if (b.kind === "text") {
          return <MessageBubble key={i} role="assistant" content={b.content} />;
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
