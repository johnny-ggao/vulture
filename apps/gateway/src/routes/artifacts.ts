import { Hono } from "hono";
import type { ArtifactKind, ArtifactStore, CreateArtifactInput } from "../domain/artifactStore";

export function artifactsRouter(store: ArtifactStore): Hono {
  const app = new Hono();

  app.get("/v1/artifacts", (c) => {
    return c.json({
      items: store.list({
        runId: c.req.query("runId"),
        conversationId: c.req.query("conversationId"),
        agentId: c.req.query("agentId"),
      }),
    });
  });

  app.get("/v1/runs/:rid/artifacts", (c) => {
    return c.json({ items: store.list({ runId: c.req.param("rid") }) });
  });

  app.post("/v1/artifacts", async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    try {
      return c.json(store.create(parseArtifact(raw)), 201);
    } catch (err) {
      return c.json({ code: "artifact.invalid", message: errorMessage(err) }, 400);
    }
  });

  return app;
}

function parseArtifact(raw: unknown): CreateArtifactInput {
  if (!raw || typeof raw !== "object") throw new Error("body must be an object");
  const value = raw as Record<string, unknown>;
  const kind = value.kind;
  if (kind !== "file" && kind !== "text" && kind !== "link" && kind !== "data") {
    throw new Error("kind is invalid");
  }
  return {
    runId: stringField(value, "runId"),
    conversationId: stringField(value, "conversationId"),
    agentId: stringField(value, "agentId"),
    kind: kind as ArtifactKind,
    title: stringField(value, "title"),
    mimeType: nullableString(value.mimeType),
    path: nullableString(value.path),
    url: nullableString(value.url),
    content: nullableString(value.content),
    metadata: isRecord(value.metadata) ? value.metadata : undefined,
  };
}

function stringField(value: Record<string, unknown>, field: string): string {
  const actual = value[field];
  if (typeof actual !== "string") throw new Error(`${field} is required`);
  return actual;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
