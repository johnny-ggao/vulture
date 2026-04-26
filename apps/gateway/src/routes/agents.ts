import { Hono } from "hono";
import { AgentStore } from "../domain/agentStore";
import { SaveAgentRequestSchema } from "@vulture/protocol/src/v1/agent";
import { requireIdempotencyKey, idempotencyCache } from "../middleware/idempotency";

export function agentsRouter(store: AgentStore): Hono {
  const app = new Hono();

  app.get("/v1/agents", (c) => c.json({ items: store.list() }));

  app.get("/v1/agents/:id", (c) => {
    const a = store.get(c.req.param("id"));
    if (!a) return c.json({ code: "agent.not_found", message: c.req.param("id") }, 404);
    return c.json(a);
  });

  app.post(
    "/v1/agents",
    requireIdempotencyKey,
    idempotencyCache(),
    async (c) => {
      const raw = await c.req.json().catch(() => ({}));
      const parsed = SaveAgentRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ code: "internal", message: parsed.error.message }, 400);
      }
      const a = store.save(parsed.data);
      return c.json(a, 201);
    },
  );

  app.patch("/v1/agents/:id", async (c) => {
    const id = c.req.param("id");
    const existing = store.get(id);
    if (!existing) return c.json({ code: "agent.not_found", message: id }, 404);
    const raw = await c.req.json().catch(() => ({}));
    const merged = {
      id,
      name: raw.name ?? existing.name,
      description: raw.description ?? existing.description,
      model: raw.model ?? existing.model,
      reasoning: raw.reasoning ?? existing.reasoning,
      tools: raw.tools ?? existing.tools,
      instructions: raw.instructions ?? existing.instructions,
    };
    const parsed = SaveAgentRequestSchema.safeParse(merged);
    if (!parsed.success) {
      return c.json({ code: "internal", message: parsed.error.message }, 400);
    }
    return c.json(store.save(parsed.data));
  });

  app.delete("/v1/agents/:id", (c) => {
    try {
      store.delete(c.req.param("id"));
      return c.body(null, 204);
    } catch (err) {
      return c.json(
        {
          code: "agent.cannot_delete_last",
          message: err instanceof Error ? err.message : String(err),
        },
        409,
      );
    }
  });

  return app;
}
