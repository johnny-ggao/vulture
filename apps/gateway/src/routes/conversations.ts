import { Hono } from "hono";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { CreateConversationRequestSchema } from "@vulture/protocol/src/v1/conversation";
import { requireIdempotencyKey, idempotencyCache } from "../middleware/idempotency";

export interface ConversationsDeps {
  conversations: ConversationStore;
  messages: MessageStore;
}

export function conversationsRouter(deps: ConversationsDeps): Hono {
  const app = new Hono();

  app.get("/v1/conversations", (c) => {
    const agentId = c.req.query("agentId");
    return c.json({ items: deps.conversations.list(agentId ? { agentId } : {}) });
  });

  app.post(
    "/v1/conversations",
    requireIdempotencyKey,
    idempotencyCache(),
    async (c) => {
      const raw = await c.req.json().catch(() => ({}));
      const parsed = CreateConversationRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ code: "internal", message: parsed.error.message }, 400);
      }
      return c.json(deps.conversations.create(parsed.data), 201);
    },
  );

  app.get("/v1/conversations/:id", (c) => {
    const conv = deps.conversations.get(c.req.param("id"));
    if (!conv) return c.json({ code: "conversation.not_found", message: c.req.param("id") }, 404);
    return c.json(conv);
  });

  app.get("/v1/conversations/:id/messages", (c) => {
    const id = c.req.param("id");
    const conv = deps.conversations.get(id);
    if (!conv) return c.json({ code: "conversation.not_found", message: id }, 404);
    const after = c.req.query("afterMessageId") ?? undefined;
    return c.json({
      items: deps.messages.listSince({ conversationId: id, afterMessageId: after }),
    });
  });

  app.delete("/v1/conversations/:id", (c) => {
    deps.conversations.delete(c.req.param("id"));
    return c.body(null, 204);
  });

  return app;
}
