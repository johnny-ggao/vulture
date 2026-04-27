import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { RunStore } from "../domain/runStore";
import { PostMessageRequestSchema } from "@vulture/protocol/src/v1/conversation";
import {
  requireIdempotencyKey,
  idempotencyCache,
} from "../middleware/idempotency";
import { orchestrateRun } from "../runtime/runOrchestrator";
import type { LlmCallable, ToolCallable } from "@vulture/agent-runtime";

export interface RunsDeps {
  conversations: ConversationStore;
  messages: MessageStore;
  runs: RunStore;
  llm: LlmCallable;
  tools: ToolCallable;
  systemPromptForAgent(a: { id: string }): string;
  modelForAgent(a: { id: string }): string;
  workspacePathForAgent(a: { id: string }): string;
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
      const userMsg = deps.messages.append({
        conversationId: cid,
        role: "user",
        content: parsed.data.input,
        runId: null,
      });
      const run = deps.runs.create({
        conversationId: cid,
        agentId: conv.agentId,
        triggeredByMessageId: userMsg.id,
      });

      // Fire-and-forget orchestrator; SSE consumers see appended events.
      orchestrateRun(deps, {
        runId: run.id,
        agentId: conv.agentId,
        model: deps.modelForAgent({ id: conv.agentId }),
        systemPrompt: deps.systemPromptForAgent({ id: conv.agentId }),
        workspacePath: deps.workspacePathForAgent({ id: conv.agentId }),
        conversationId: cid,
        userInput: parsed.data.input,
      }).catch((err) => {
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

  app.get("/v1/runs/:rid/events", (c) => {
    const rid = c.req.param("rid");
    const run = deps.runs.get(rid);
    if (!run) return c.json({ code: "run.not_found", message: rid }, 404);
    const lastSeqHeader = c.req.header("Last-Event-ID");
    const lastSeq = lastSeqHeader ? Number.parseInt(lastSeqHeader, 10) : -1;

    return streamSSE(c, async (stream) => {
      let sentSeq = lastSeq;
      // Replay any events already buffered before subscription
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
      // Poll-loop until terminal OR client abort
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
        await sleep(100);
      }
    });
  });

  app.post("/v1/runs/:rid/cancel", (c) => {
    const rid = c.req.param("rid");
    const run = deps.runs.get(rid);
    if (!run) return c.json({ code: "run.not_found", message: rid }, 404);
    if (["succeeded", "failed", "cancelled"].includes(run.status)) {
      return c.json({ code: "run.already_completed", message: run.status }, 409);
    }
    deps.runs.markCancelled(rid);
    deps.runs.appendEvent(rid, { type: "run.cancelled" });
    return c.json(deps.runs.get(rid), 202);
  });

  app.post("/v1/runs/:rid/approvals", async (c) => {
    // Phase 3a stub: accepts approval token + decision, persists nothing yet.
    // Wired into the runner in 3b when UI shows tool.ask events.
    const rid = c.req.param("rid");
    const run = deps.runs.get(rid);
    if (!run) return c.json({ code: "run.not_found", message: rid }, 404);
    return c.body(null, 202);
  });

  return app;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
