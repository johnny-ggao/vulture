import { Hono, type Context } from "hono";
import type { MessageStore } from "../domain/messageStore";
import type { RunStore } from "../domain/runStore";
import type { SubagentSession, SubagentSessionStore } from "../domain/subagentSessionStore";
import type { RunEvent } from "@vulture/protocol/src/v1/run";

export interface SubagentSessionsDeps {
  sessions: SubagentSessionStore;
  messages: MessageStore;
  runs: RunStore;
}

export function subagentSessionsRouter(deps: SubagentSessionsDeps): Hono {
  const app = new Hono();

  app.get("/v1/subagent-sessions", (c) => {
    const limit = parsePositiveInt(c.req.query("limit"));
    return c.json({
      items: deps.sessions.list({
        parentConversationId: c.req.query("parentConversationId") ?? undefined,
        parentRunId: c.req.query("parentRunId") ?? undefined,
        agentId: c.req.query("agentId") ?? undefined,
        limit,
      }).map((session) => withPendingApprovals(deps, session)),
    });
  });

  app.get("/v1/subagent-sessions/:id", (c) => {
    const id = c.req.param("id");
    const session = deps.sessions.refreshStatus(id) ?? deps.sessions.get(id);
    if (!session) return notFound(c, id);
    return c.json(withPendingApprovals(deps, session));
  });

  app.get("/v1/subagent-sessions/:id/messages", (c) => {
    const id = c.req.param("id");
    const session = deps.sessions.refreshStatus(id) ?? deps.sessions.get(id);
    if (!session) return notFound(c, id);
    const limit = parsePositiveInt(c.req.query("limit")) ?? 50;
    const items = deps.messages
      .listSince({ conversationId: session.conversationId })
      .slice(-limit);
    return c.json({ session: withPendingApprovals(deps, session), items });
  });

  return app;
}

function withPendingApprovals(deps: SubagentSessionsDeps, session: SubagentSession) {
  if (session.status !== "active") return { ...session, pendingApprovals: [] };
  const activeRuns = deps.runs.listForConversation(session.conversationId, { status: "active" });
  return {
    ...session,
    pendingApprovals: activeRuns.flatMap((run) =>
      pendingApprovalsFromEvents(deps.runs.listEventsAfter(run.id, -1)),
    ),
  };
}

function pendingApprovalsFromEvents(events: readonly RunEvent[]) {
  const pending = new Map<string, {
    runId: string;
    callId: string;
    tool: string;
    reason: string;
    approvalToken: string;
    seq: number;
  }>();
  for (const event of events) {
    if (event.type === "tool.ask") {
      pending.set(event.callId, {
        runId: event.runId,
        callId: event.callId,
        tool: event.tool,
        reason: event.reason,
        approvalToken: event.approvalToken,
        seq: event.seq,
      });
    } else if (
      event.type === "run.cancelled" ||
      event.type === "run.failed" ||
      event.type === "run.completed"
    ) {
      pending.clear();
    } else if (
      (event.type === "tool.started" || event.type === "tool.completed" || event.type === "tool.failed") &&
      event.callId !== undefined
    ) {
      pending.delete(event.callId);
    }
  }
  return [...pending.values()];
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function notFound(c: Context, id: string): Response {
  return c.json({ code: "subagent_session.not_found", message: id }, 404);
}
