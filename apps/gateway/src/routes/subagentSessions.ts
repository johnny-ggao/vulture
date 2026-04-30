import { Hono } from "hono";
import type { MessageStore } from "../domain/messageStore";
import type { SubagentSessionStore } from "../domain/subagentSessionStore";

export interface SubagentSessionsDeps {
  sessions: SubagentSessionStore;
  messages: MessageStore;
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
      }),
    });
  });

  app.get("/v1/subagent-sessions/:id", (c) => {
    const id = c.req.param("id");
    const session = deps.sessions.refreshStatus(id) ?? deps.sessions.get(id);
    if (!session) return notFound(c, id);
    return c.json(session);
  });

  app.get("/v1/subagent-sessions/:id/messages", (c) => {
    const id = c.req.param("id");
    const session = deps.sessions.refreshStatus(id) ?? deps.sessions.get(id);
    if (!session) return notFound(c, id);
    const limit = parsePositiveInt(c.req.query("limit")) ?? 50;
    const items = deps.messages
      .listSince({ conversationId: session.conversationId })
      .slice(-limit);
    return c.json({ session, items });
  });

  return app;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function notFound(c: Parameters<Parameters<Hono["get"]>[1]>[0], id: string): Response {
  return c.json({ code: "subagent_session.not_found", message: id }, 404);
}
