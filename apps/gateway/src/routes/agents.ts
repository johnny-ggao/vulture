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

  app.get("/v1/agents/:id/files", (c) => {
    const id = c.req.param("id");
    if (!store.get(id)) return c.json({ code: "agent.not_found", message: id }, 404);
    return c.json({
      agentId: id,
      rootPath: store.agentRootPath(id),
      corePath: store.agentCorePath(id),
      files: store.listAgentCoreFiles(id),
    });
  });

  app.get("/v1/agents/:id/files/:name", (c) => {
    const id = c.req.param("id");
    if (!store.get(id)) return c.json({ code: "agent.not_found", message: id }, 404);
    try {
      return c.json({
        agentId: id,
        rootPath: store.agentRootPath(id),
        corePath: store.agentCorePath(id),
        file: store.readAgentCoreFile(id, decodeURIComponent(c.req.param("name"))),
      });
    } catch (err) {
      return c.json({ code: "agent.file_unsupported", message: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.put("/v1/agents/:id/files/:name", async (c) => {
    const id = c.req.param("id");
    if (!store.get(id)) return c.json({ code: "agent.not_found", message: id }, 404);
    const raw = await c.req.json().catch(() => ({}));
    const content = typeof raw.content === "string" ? raw.content : null;
    if (content === null) {
      return c.json({ code: "agent.file_content_required", message: "content is required" }, 400);
    }
    try {
      return c.json({
        agentId: id,
        rootPath: store.agentRootPath(id),
        corePath: store.agentCorePath(id),
        file: store.writeAgentCoreFile(id, decodeURIComponent(c.req.param("name")), content),
      });
    } catch (err) {
      return c.json({ code: "agent.file_unsupported", message: err instanceof Error ? err.message : String(err) }, 400);
    }
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
    const hasSkills = Object.prototype.hasOwnProperty.call(raw, "skills");
    const hasTools = Object.prototype.hasOwnProperty.call(raw, "tools");
    const hasToolPreset = Object.prototype.hasOwnProperty.call(raw, "toolPreset");
    const hasToolInclude = Object.prototype.hasOwnProperty.call(raw, "toolInclude");
    const hasToolExclude = Object.prototype.hasOwnProperty.call(raw, "toolExclude");
    const hasHandoffs = Object.prototype.hasOwnProperty.call(raw, "handoffAgentIds");
    const merged = {
      id,
      name: raw.name ?? existing.name,
      description: raw.description ?? existing.description,
      model: raw.model ?? existing.model,
      reasoning: raw.reasoning ?? existing.reasoning,
      tools: hasTools ? raw.tools : existing.tools,
      toolPreset: hasToolPreset ? raw.toolPreset : existing.toolPreset,
      toolInclude: hasToolInclude ? raw.toolInclude : existing.toolInclude,
      toolExclude: hasToolExclude ? raw.toolExclude : existing.toolExclude,
      skills: hasSkills ? (raw.skills === null ? undefined : raw.skills) : existing.skills,
      handoffAgentIds: hasHandoffs ? raw.handoffAgentIds : existing.handoffAgentIds,
      workspace:
        raw.workspace ??
        {
          id: existing.workspace.id,
          name: existing.workspace.name,
          path: existing.workspace.path,
        },
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
