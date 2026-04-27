import type { AnyRunEvent } from "../hooks/useRunStream";
import type { ApprovalDecision } from "../api/runs";
import { MessageBubble } from "./MessageBubble";
import { ToolBlock, type ToolBlockStatus } from "./ToolBlock";
import { ApprovalCard } from "./ApprovalCard";

export type RunBlock =
  | { kind: "text"; content: string; firstSeq: number }
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
  const blocks: RunBlock[] = [];
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
        const idx = toolIndex.get(callId);
        if (idx !== undefined && blocks[idx].kind === "tool") {
          const block = blocks[idx] as Extract<RunBlock, { kind: "tool" }>;
          blocks[idx] = { ...block, status: "running" };
        }
        break;
      }
      case "tool.completed": {
        const callId = String(e.callId);
        const idx = toolIndex.get(callId);
        if (idx !== undefined && blocks[idx].kind === "tool") {
          const block = blocks[idx] as Extract<RunBlock, { kind: "tool" }>;
          blocks[idx] = { ...block, status: "completed", output: e.output };
        }
        // Approval block (if any) is satisfied; we keep it inline for context
        // — downstream renderer decides whether to fade/hide it.
        break;
      }
      case "tool.failed": {
        const callId = String(e.callId);
        const idx = toolIndex.get(callId);
        if (idx !== undefined && blocks[idx].kind === "tool") {
          const block = blocks[idx] as Extract<RunBlock, { kind: "tool" }>;
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
      // run.started / run.completed / run.failed / run.cancelled produce no inline block
    }
  }

  return blocks;
}

export interface RunEventStreamProps {
  events: readonly AnyRunEvent[];
  submittingApprovals: ReadonlySet<string>;
  onDecide: (callId: string, decision: ApprovalDecision) => void;
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
