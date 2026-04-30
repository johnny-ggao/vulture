import { Hono } from "hono";
import { createCoreToolRegistry } from "../tools/coreTools";

export function mcpProxyRouter(): Hono {
  const app = new Hono();

  app.get("/v1/mcp/server/manifest", (c) => {
    const tools = createCoreToolRegistry().list().map((tool) => ({
      name: tool.sdkName,
      id: tool.id,
      label: tool.label,
      description: tool.description,
      category: tool.category,
      risk: tool.risk,
      idempotent: tool.idempotent,
    }));
    return c.json({
      name: "vulture-local-tools",
      protocol: "mcp",
      status: "planned",
      transport: "stdio",
      tools,
      cli: {
        command: "bun",
        args: ["--filter", "@vulture/gateway", "mcp:server"],
      },
    });
  });

  return app;
}
