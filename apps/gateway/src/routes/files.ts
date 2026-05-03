import { Hono } from "hono";
import { runGlob } from "../runtime/glob";

export interface FilesListResponse {
  paths: string[];
  truncated: boolean;
}

/**
 * Lightweight file lister for the @-mention picker. The UI sends an absolute
 * `root` (the conversation's working directory) and gets back relative paths
 * under it, capped at 500. The handler delegates to `runGlob` so it shares
 * the same skip-list (.git, node_modules, etc.) and tinyglobby plumbing as
 * the agent's `glob` tool.
 *
 * Path safety: the returned paths are relative — callers may NOT escape
 * `root` because runGlob's globber doesn't follow `..`. The query refuses
 * non-absolute or empty roots so a misbehaving client can't probe `/`.
 */
export function filesRouter(): Hono {
  const app = new Hono();

  app.get("/v1/files", async (c) => {
    const root = c.req.query("root");
    const maxRaw = c.req.query("max");
    if (!root || root.length === 0) {
      return c.json({ code: "internal", message: "root query param is required" }, 400);
    }
    if (!root.startsWith("/")) {
      return c.json(
        { code: "internal", message: "root must be an absolute path" },
        400,
      );
    }
    const max = maxRaw ? Math.min(Math.max(1, Number.parseInt(maxRaw, 10) || 500), 2000) : 500;
    const result = await runGlob({ pattern: "**/*", path: root, maxResults: max });
    const paths = result.paths
      .map((p) => p.startsWith(root + "/") ? p.slice(root.length + 1) : p)
      .filter((p) => p.length > 0);
    const body: FilesListResponse = { paths, truncated: result.truncated };
    return c.json(body);
  });

  return app;
}
