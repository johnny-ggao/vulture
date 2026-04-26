import { Hono } from "hono";
import { WorkspaceStore } from "../domain/workspaceStore";
import { SaveWorkspaceRequestSchema } from "@vulture/protocol/src/v1/workspace";
import { requireIdempotencyKey, idempotencyCache } from "../middleware/idempotency";

export function workspacesRouter(store: WorkspaceStore): Hono {
  const app = new Hono();

  app.get("/v1/workspaces", (c) => c.json({ items: store.list() }));

  app.post(
    "/v1/workspaces",
    requireIdempotencyKey,
    idempotencyCache(),
    async (c) => {
      const raw = await c.req.json().catch(() => ({}));
      const parsed = SaveWorkspaceRequestSchema.safeParse(raw);
      if (!parsed.success) {
        return c.json({ code: "internal", message: parsed.error.message }, 400);
      }
      try {
        const ws = store.save(parsed.data);
        return c.json(ws, 201);
      } catch (err) {
        return c.json(
          {
            code: "workspace.invalid_path",
            message: err instanceof Error ? err.message : String(err),
          },
          422,
        );
      }
    },
  );

  app.delete("/v1/workspaces/:id", (c) => {
    store.delete(c.req.param("id"));
    return c.body(null, 204);
  });

  return app;
}
