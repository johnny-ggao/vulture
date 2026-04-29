import { describe, expect, test } from "bun:test";
import { buildToolCatalog, toolsRouter } from "./tools";

describe("/v1/tools/catalog", () => {
  test("groups core tools with retry and risk metadata", async () => {
    const app = toolsRouter();
    const res = await app.request("/v1/tools/catalog");
    expect(res.status).toBe(200);
    const body = await res.json();
    const tools = body.groups.flatMap((group: { items: Array<{ id: string }> }) => group.items);
    expect(tools).toContainEqual(
      expect.objectContaining({
        id: "read",
        category: "fs",
        risk: "safe",
        idempotent: true,
      }),
    );
    expect(tools).toContainEqual(
      expect.objectContaining({
        id: "shell.exec",
        category: "runtime",
        risk: "approval",
        idempotent: false,
      }),
    );
  });

  test("buildToolCatalog keeps stable category order", () => {
    expect(buildToolCatalog().groups.map((group) => group.id).slice(0, 3)).toEqual([
      "fs",
      "runtime",
      "web",
    ]);
  });
});
