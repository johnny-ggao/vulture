import { Hono } from "hono";
import { createCoreToolRegistry } from "../tools/coreTools";

export function browserCapabilitiesRouter(): Hono {
  const app = new Hono();

  app.get("/v1/browser/capabilities", (c) => {
    const tools = createCoreToolRegistry()
      .list()
      .filter((tool) => tool.category === "browser")
      .map((tool) => ({
        id: tool.id,
        label: tool.label,
        description: tool.description,
        risk: tool.risk,
        idempotent: tool.idempotent,
        sdkName: tool.sdkName,
      }));
    return c.json({
      status: tools.length > 0 ? "partial" : "unavailable",
      supportedTools: tools,
      plannedCapabilities: [
        "navigate",
        "input",
        "wait",
        "screenshot",
        "multi-tab-session",
      ],
    });
  });

  return app;
}
