import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { RunStore } from "../domain/runStore";
import { AttachmentStore } from "../domain/attachmentStore";
import {
  PostMessageRequestSchema,
  type MessageAttachment,
} from "@vulture/protocol/src/v1/conversation";
import { ApprovalRequestSchema } from "@vulture/protocol/src/v1/approval";
import type { RunStatus } from "@vulture/protocol/src/v1/run";
import {
  requireIdempotencyKey,
  idempotencyCache,
} from "../middleware/idempotency";
import { orchestrateRun } from "../runtime/runOrchestrator";
import type { LlmAttachment, LlmCallable, ToolCallable } from "@vulture/agent-runtime";
import type { ApprovalQueue } from "../runtime/approvalQueue";

export type ResumeRunResult =
  | { status: "scheduled" }
  | { status: "already_started" }
  | { status: "missing_state" };

export interface RunsDeps {
  conversations: ConversationStore;
  messages: MessageStore;
  attachments: AttachmentStore;
  runs: RunStore;
  llm: LlmCallable;
  tools: ToolCallable;
  approvalQueue: ApprovalQueue;
  cancelSignals: Map<string, AbortController>;
  resumeRun(runId: string, mode: "auto" | "manual"): ResumeRunResult;
  systemPromptForAgent(a: { id: string }): string;
  skillsPromptForAgent?: (a: { id: string }) => string;
  memoryPromptForRun?: (a: { agentId: string; input: string }) => Promise<string> | string;
  afterRunSucceeded?: Parameters<typeof orchestrateRun>[0]["afterRunSucceeded"];
  modelForAgent(a: { id: string }): string;
  workspacePathForAgent(a: { id: string }): string;
}

interface RunEventStream {
  aborted: boolean;
  closed: boolean;
  writeSSE(message: { id?: string; event?: string; data: string }): Promise<unknown>;
}

export interface RunEventStreamOptions {
  heartbeatMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 15_000;
const RUN_STATUS_FILTERS = new Set<string>([
  "queued",
  "running",
  "recoverable",
  "succeeded",
  "failed",
  "cancelled",
  "active",
]);
type RunStatusFilter = RunStatus | "active";

export async function writeRunEventStream(
  deps: Pick<RunsDeps, "runs">,
  rid: string,
  lastSeq: number,
  stream: RunEventStream,
  opts: RunEventStreamOptions = {},
): Promise<void> {
  const heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  let sentSeq = lastSeq;

  const writePing = async () => {
    if (stream.aborted || stream.closed) return;
    await stream.writeSSE({ event: "ping", data: "{}" });
  };

  // Replay any events already buffered before subscription.
  const missed = deps.runs.listEventsAfter(rid, sentSeq);
  for (const ev of missed) {
    if (stream.aborted || stream.closed) return;
    await stream.writeSSE({
      id: String(ev.seq),
      event: ev.type,
      data: JSON.stringify(ev),
    });
    sentSeq = ev.seq;
  }

  const current = deps.runs.get(rid);
  const isTerminalRun =
    current?.status === "succeeded" ||
    current?.status === "failed" ||
    current?.status === "cancelled";
  if (missed.length === 0 && isTerminalRun) {
    const terminalEvent = latestTerminalEvent(deps.runs.listEventsAfter(rid, -1));
    if (terminalEvent) {
      await stream.writeSSE({
        id: String(terminalEvent.seq),
        event: terminalEvent.type,
        data: JSON.stringify(terminalEvent),
      });
    }
    return;
  }

  // If the reconnect is already caught up, flush a lightweight frame so
  // browser fetch/read loops can observe that the SSE connection recovered.
  if (missed.length === 0) {
    await writePing();
  }

  // Notification primitive: resolves whenever a new event is appended.
  // Each notify resolves the current promise and re-arms a new one so
  // rapid back-to-back events are never missed — the next loop iteration
  // will drain all of them via listEventsAfter.
  let resolveNotify: () => void = () => {};
  let notifyPromise = new Promise<void>((r) => { resolveNotify = r; });
  const unsubscribe = deps.runs.subscribe(rid, () => {
    resolveNotify();
    notifyPromise = new Promise<void>((r) => { resolveNotify = r; });
  });

  try {
    while (!stream.aborted && !stream.closed) {
      const cur = deps.runs.get(rid);
      if (!cur) break;

      const more = deps.runs.listEventsAfter(rid, sentSeq);
      for (const ev of more) {
        if (stream.aborted || stream.closed) return;
        await stream.writeSSE({
          id: String(ev.seq),
          event: ev.type,
          data: JSON.stringify(ev),
        });
        sentSeq = ev.seq;
      }

      if (cur.status === "succeeded" || cur.status === "failed" || cur.status === "cancelled") {
        break;
      }

      const waitResult = await Promise.race([
        notifyPromise.then(() => "notify" as const),
        new Promise<"heartbeat">((r) => setTimeout(() => r("heartbeat"), heartbeatMs)),
      ]);
      if (waitResult === "heartbeat") await writePing();
    }
  } finally {
    unsubscribe();
  }
}

function latestTerminalEvent(events: ReturnType<RunStore["listEventsAfter"]>) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (
      event.type === "run.completed" ||
      event.type === "run.failed" ||
      event.type === "run.cancelled"
    ) {
      return event;
    }
  }
  return null;
}

export function runsRouter(deps: RunsDeps): Hono {
  const app = new Hono();

  app.post(
    "/v1/conversations/:cid/runs",
    requireIdempotencyKey,
    idempotencyCache(),
    async (c) => {
      const cid = c.req.param("cid");
      const conv = deps.conversations.get(cid);
      if (!conv) return c.json({ code: "conversation.not_found", message: cid }, 404);
      const raw = await c.req.json().catch(() => ({}));
      const parsed = PostMessageRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ code: "internal", message: parsed.error.message }, 400);
      }
      const appendedUserMsg = deps.messages.append({
        conversationId: cid,
        role: "user",
        content: parsed.data.input,
        runId: null,
      });
      try {
        deps.attachments.linkToMessage(parsed.data.attachmentIds ?? [], appendedUserMsg.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "attachment.not_found") {
          return c.json({ code: "attachment.not_found", message }, 404);
        }
        if (message === "attachment.already_used") {
          return c.json({ code: "attachment.already_used", message }, 409);
        }
        return c.json({ code: "internal", message }, 400);
      }
      const userMsg = deps.messages.get(appendedUserMsg.id) ?? appendedUserMsg;
      const runtimeAttachments = toRuntimeAttachments(deps.attachments, userMsg.attachments);
      const run = deps.runs.create({
        conversationId: cid,
        agentId: conv.agentId,
        triggeredByMessageId: userMsg.id,
      });
      const contextPrompt = combineContextPrompts(
        await safeMemoryPrompt(deps, { agentId: conv.agentId, input: parsed.data.input }),
        deps.skillsPromptForAgent?.({ id: conv.agentId }),
      );

      // Fire-and-forget orchestrator; SSE consumers see appended events.
      orchestrateRun(
        {
          runs: deps.runs,
          messages: deps.messages,
          conversations: deps.conversations,
          llm: deps.llm,
          tools: deps.tools,
          cancelSignals: deps.cancelSignals,
          afterRunSucceeded: deps.afterRunSucceeded,
        },
        {
          runId: run.id,
          agentId: conv.agentId,
          model: deps.modelForAgent({ id: conv.agentId }),
          systemPrompt: deps.systemPromptForAgent({ id: conv.agentId }),
          contextPrompt,
          workspacePath: deps.workspacePathForAgent({ id: conv.agentId }),
          conversationId: cid,
          userInput: parsed.data.input,
          attachments: runtimeAttachments,
        },
      ).catch((err) => {
        deps.runs.markFailed(run.id, {
          code: "internal",
          message: err instanceof Error ? err.message : String(err),
        });
      });

      return c.json(
        {
          run,
          message: userMsg,
          eventStreamUrl: `/v1/runs/${run.id}/events`,
        },
        202,
      );
    },
  );

  app.get("/v1/runs/:rid", (c) => {
    const rid = c.req.param("rid");
    const run = deps.runs.get(rid);
    if (!run) return c.json({ code: "run.not_found", message: rid }, 404);
    return c.json(run);
  });

  app.get("/v1/conversations/:cid/runs", (c) => {
    const cid = c.req.param("cid");
    const conv = deps.conversations.get(cid);
    if (!conv) return c.json({ code: "conversation.not_found", message: cid }, 404);
    const status = c.req.query("status");
    if (status && !RUN_STATUS_FILTERS.has(status)) {
      return c.json({ code: "internal", message: `invalid run status filter: ${status}` }, 400);
    }
    return c.json({
      items: deps.runs.listForConversation(
        cid,
        status ? { status: status as RunStatusFilter } : {},
      ),
    });
  });

  app.get("/v1/runs/:rid/events", (c) => {
    const rid = c.req.param("rid");
    const run = deps.runs.get(rid);
    if (!run) return c.json({ code: "run.not_found", message: rid }, 404);
    const lastSeqHeader = c.req.header("Last-Event-ID");
    const lastSeq = lastSeqHeader ? Number.parseInt(lastSeqHeader, 10) : -1;

    return streamSSE(c, async (stream) => {
      await writeRunEventStream({ runs: deps.runs }, rid, lastSeq, stream);
    });
  });

  app.post("/v1/runs/:rid/cancel", (c) => {
    const rid = c.req.param("rid");
    const run = deps.runs.get(rid);
    if (!run) return c.json({ code: "run.not_found", message: rid }, 404);
    if (["succeeded", "failed", "cancelled"].includes(run.status)) {
      return c.json({ code: "run.already_completed", message: run.status }, 409);
    }
    // Abort any pending approvalQueue.wait for this run; the orchestrator's
    // try/finally will clean up cancelSignals on completion.
    deps.cancelSignals.get(rid)?.abort();
    deps.runs.markCancelled(rid);
    deps.runs.appendEvent(rid, { type: "run.cancelled" });
    return c.json(deps.runs.get(rid), 202);
  });

  app.post("/v1/runs/:rid/resume", (c) => {
    const rid = c.req.param("rid");
    const run = deps.runs.get(rid);
    if (!run) return c.json({ code: "run.not_found", message: rid }, 404);
    if (run.status !== "recoverable") {
      return c.json({ code: "run.not_recoverable", message: run.status }, 409);
    }
    const result = deps.resumeRun(rid, "manual");
    if (result.status === "already_started") {
      return c.json({ code: "run.not_recoverable", message: "already started" }, 409);
    }
    if (result.status === "missing_state") {
      return c.json(
        {
          code: "internal.recovery_state_unavailable",
          message: `recovery state unavailable for ${rid}`,
        },
        409,
      );
    }
    return c.json(deps.runs.get(rid), 202);
  });

  app.post("/v1/runs/:rid/approvals", async (c) => {
    const rid = c.req.param("rid");
    const run = deps.runs.get(rid);
    if (!run) return c.json({ code: "run.not_found", message: rid }, 404);

    const raw = await c.req.json().catch(() => ({}));
    const parsed = ApprovalRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ code: "internal", message: parsed.error.message }, 400);
    }

    const ok = deps.approvalQueue.resolve(parsed.data.callId, parsed.data.decision);
    if (!ok) {
      return c.json(
        { code: "internal", message: `no pending approval for callId ${parsed.data.callId}` },
        404,
      );
    }
    return c.body(null, 202);
  });

  return app;
}

export function combineContextPrompts(...parts: Array<string | undefined | null>): string | undefined {
  const joined = parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  return joined.length > 0 ? `\n\n${joined}` : undefined;
}

async function safeMemoryPrompt(
  deps: Pick<RunsDeps, "memoryPromptForRun">,
  input: { agentId: string; input: string },
): Promise<string> {
  if (!deps.memoryPromptForRun) return "";
  try {
    return await deps.memoryPromptForRun(input);
  } catch {
    return "";
  }
}

function toRuntimeAttachments(
  store: AttachmentStore,
  attachments: MessageAttachment[],
): LlmAttachment[] {
  return attachments.map((attachment) => {
    const content = store.getContent(attachment.id);
    if (!content) throw new Error(`attachment content missing: ${attachment.id}`);
    return {
      id: attachment.id,
      kind: attachment.kind,
      displayName: attachment.displayName,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      dataBase64: content.bytes.toString("base64"),
    };
  });
}
