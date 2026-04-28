import { Hono } from "hono";
import { z } from "zod";
import {
  isMcpToolEnabled,
  McpServerStore,
  type McpServerConfig,
  type SaveMcpServerConfig,
  type UpdateMcpServerConfig,
} from "../domain/mcpServerStore";

export type McpRuntimeStatus = {
  status: "connected" | "disconnected" | "failed";
  lastError: string | null;
  toolCount: number;
  updatedAt: string | null;
};

export interface McpRuntimeView {
  status: (serverId: string) => McpRuntimeStatus | undefined;
  reconnect: (serverId: string) => Promise<void>;
  tools: (serverId: string) => Promise<Array<{ name: string; description?: string }>>;
}

export interface McpServersRouterDeps {
  store: McpServerStore;
  runtime?: McpRuntimeView;
}

const ServerSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    transport: z.literal("stdio"),
    command: z.string(),
    args: z.array(z.string()).optional(),
    cwd: z.string().nullable().optional(),
    env: z.record(z.string(), z.string()).optional(),
    trust: z.enum(["trusted", "ask", "disabled"]).optional(),
    enabled: z.boolean().optional(),
    enabledTools: z.array(z.string()).nullable().optional(),
    disabledTools: z.array(z.string()).optional(),
  })
  .strict();

const PatchSchema = z
  .object({
    name: z.string().min(1).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().nullable().optional(),
    env: z.record(z.string(), z.string()).optional(),
    trust: z.enum(["trusted", "ask", "disabled"]).optional(),
    enabled: z.boolean().optional(),
    enabledTools: z.array(z.string()).nullable().optional(),
    disabledTools: z.array(z.string()).optional(),
  })
  .strict();

export function mcpServersRouter(deps: McpServersRouterDeps): Hono {
  const app = new Hono();

  app.get("/v1/mcp/servers", (c) => {
    return c.json({ items: deps.store.list().map((server) => toView(server, deps.runtime)) });
  });

  app.post("/v1/mcp/servers", async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const parsed = ServerSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ code: "internal", message: parsed.error.message }, 400);
    }
    try {
      const created = deps.store.create(parsed.data satisfies SaveMcpServerConfig);
      return c.json(toView(created, deps.runtime), 201);
    } catch (err) {
      return c.json({ code: "internal", message: errorMessage(err) }, 400);
    }
  });

  app.patch("/v1/mcp/servers/:id", async (c) => {
    const id = c.req.param("id");
    if (!deps.store.get(id)) {
      return c.json({ code: "mcp.not_found", message: id }, 404);
    }
    const raw = await c.req.json().catch(() => ({}));
    const parsed = PatchSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ code: "internal", message: parsed.error.message }, 400);
    }
    try {
      const updated = deps.store.update(id, parsed.data satisfies UpdateMcpServerConfig);
      await deps.runtime?.reconnect(id).catch(() => undefined);
      return c.json(toView(updated, deps.runtime));
    } catch (err) {
      return c.json({ code: "internal", message: errorMessage(err) }, 400);
    }
  });

  app.delete("/v1/mcp/servers/:id", async (c) => {
    const id = c.req.param("id");
    deps.store.delete(id);
    await deps.runtime?.reconnect(id).catch(() => undefined);
    return c.body(null, 204);
  });

  app.post("/v1/mcp/servers/:id/reconnect", async (c) => {
    const id = c.req.param("id");
    const server = deps.store.get(id);
    if (!server) return c.json({ code: "mcp.not_found", message: id }, 404);
    try {
      await deps.runtime?.reconnect(id);
    } catch {
      // Reconnect failures are reflected through runtime status.
    }
    return c.json(toView(server, deps.runtime));
  });

  app.get("/v1/mcp/servers/:id/tools", async (c) => {
    const id = c.req.param("id");
    const server = deps.store.get(id);
    if (!server) return c.json({ code: "mcp.not_found", message: id }, 404);
    return c.json({
      items: ((await deps.runtime?.tools(id)) ?? []).map((tool) => ({
        ...tool,
        enabled: isMcpToolEnabled(server, tool.name),
      })),
    });
  });

  return app;
}

function toView(server: McpServerConfig, runtime?: McpRuntimeView) {
  return {
    id: server.id,
    profileId: server.profileId,
    name: server.name,
    transport: server.transport,
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    env: server.env,
    trust: server.trust,
    enabled: server.enabled,
    enabledTools: server.enabledTools,
    disabledTools: server.disabledTools,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    runtime: runtime?.status(server.id) ?? {
      status: "disconnected",
      lastError: null,
      toolCount: 0,
      updatedAt: null,
    },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
