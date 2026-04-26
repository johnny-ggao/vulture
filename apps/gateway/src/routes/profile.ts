import { Hono } from "hono";
import { ProfileStore } from "../domain/profileStore";
import { UpdateProfileRequestSchema } from "@vulture/protocol/src/v1/profile";

export function profileRouter(store: ProfileStore): Hono {
  const app = new Hono();
  app.get("/v1/profile", (c) => c.json(store.get()));
  app.patch("/v1/profile", async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const parsed = UpdateProfileRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { code: "internal", message: parsed.error.message },
        400,
      );
    }
    return c.json(store.update(parsed.data));
  });
  return app;
}
