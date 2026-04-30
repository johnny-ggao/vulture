import { Hono } from "hono";
import type { SkillCatalogStore } from "../domain/skillCatalogStore";

export function skillCatalogRouter(store: SkillCatalogStore): Hono {
  const app = new Hono();

  app.get("/v1/skill-catalog", (c) => c.json({ items: store.list() }));

  app.post("/v1/skill-catalog", async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    try {
      const entry = store.upsert({
        name: stringField(raw, "name"),
        description: stringField(raw, "description"),
        version: optionalStringField(raw, "version"),
        source: optionalSourceField(raw, "source"),
        packagePath: optionalStringField(raw, "packagePath"),
        homepage: optionalStringField(raw, "homepage"),
      });
      return c.json(entry, 201);
    } catch (err) {
      return c.json({ code: "skill_catalog.invalid", message: errorMessage(err) }, 400);
    }
  });

  app.post("/v1/skill-catalog/import", async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    try {
      const entry = store.importPackage({
        packagePath: stringField(raw, "packagePath"),
        source: optionalSourceField(raw, "source"),
        homepage: optionalStringField(raw, "homepage"),
      });
      return c.json(entry, 201);
    } catch (err) {
      return c.json({ code: "skill_catalog.import_failed", message: errorMessage(err) }, 400);
    }
  });

  app.post("/v1/skill-catalog/:name/install", (c) => {
    try {
      return c.json(store.install(c.req.param("name")), 200);
    } catch (err) {
      return c.json({ code: "skill_catalog.install_failed", message: errorMessage(err) }, 400);
    }
  });

  app.post("/v1/skill-catalog/update-all", (c) => c.json({ items: store.updateAll() }));

  return app;
}

function stringField(value: unknown, field: string): string {
  if (!value || typeof value !== "object") throw new Error(`${field} is required`);
  const actual = (value as Record<string, unknown>)[field];
  if (typeof actual !== "string") throw new Error(`${field} is required`);
  return actual;
}

function optionalStringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const actual = (value as Record<string, unknown>)[field];
  return typeof actual === "string" ? actual : undefined;
}

function optionalSourceField(value: unknown, field: string): "local" | "remote" | "manual" | undefined {
  const actual = optionalStringField(value, field);
  if (!actual) return undefined;
  if (actual === "local" || actual === "remote" || actual === "manual") return actual;
  throw new Error(`${field} is invalid`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
