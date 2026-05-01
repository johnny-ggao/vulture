import { Hono } from "hono";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { ConversationContextStore } from "../domain/conversationContextStore";
import {
  CreateConversationRequestSchema,
  UpdateConversationRequestSchema,
} from "@vulture/protocol/src/v1/conversation";
import { requireIdempotencyKey, idempotencyCache } from "../middleware/idempotency";

export interface ConversationsDeps {
  conversations: ConversationStore;
  messages: MessageStore;
  contexts?: ConversationContextStore;
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

  app.patch("/v1/conversations/:id", async (c) => {
    const id = c.req.param("id");
    const raw = await c.req.json().catch(() => ({}));
    const parsed = UpdateConversationRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ code: "internal", message: parsed.error.message }, 400);
    }
    const updated = deps.conversations.updatePermissionMode(id, parsed.data.permissionMode!);
    if (!updated) return c.json({ code: "conversation.not_found", message: id }, 404);
    return c.json(updated);
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

  app.get("/v1/conversations/:id/context", (c) => {
    const id = c.req.param("id");
    const conv = deps.conversations.get(id);
    if (!conv) return c.json({ code: "conversation.not_found", message: id }, 404);

    const context = deps.contexts?.getContext(id) ?? null;
    return c.json({
      conversationId: id,
      summary: context?.summary ?? "",
      summarizedThroughMessageId: context?.summarizedThroughMessageId ?? null,
      rawItemCount: deps.contexts?.listSessionItems(id).length ?? 0,
      updatedAt: context?.updatedAt ?? null,
    });
  });

  app.delete("/v1/conversations/:id", (c) => {
    const id = c.req.param("id");
    deps.contexts?.deleteConversation(id);
    deps.conversations.delete(id);
    return c.body(null, 204);
  });

  return app;
}
