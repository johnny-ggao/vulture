import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { skillsRouter } from "./skills";

function writeSkill(root: string, dirName: string, body: { name: string; description: string }): void {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    ["---", `name: ${body.name}`, `description: ${body.description}`, "---", "", `# ${body.name}`, ""].join("\n"),
  );
}

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-skills-route-"));
  const app = new Hono();
  app.route("/", skillsRouter(dir));
  return {
    app,
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("/v1/skills", () => {
  test("lists profile skills (global install scope)", async () => {
    const { app, dir, cleanup } = freshApp();
    mkdirSync(join(dir, "skills"), { recursive: true });
    writeSkill(join(dir, "skills"), "csv", {
      name: "csv-insights",
      description: "Summarize CSV reports.",
    });
    writeSkill(join(dir, "skills"), "writer", {
      name: "writer",
      description: "Draft polished copy.",
    });

    const res = await app.request("/v1/skills");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items.map((item: { name: string }) => item.name)).toEqual([
      "csv-insights",
      "writer",
    ]);
    expect(body.items[0]).toEqual(
      expect.objectContaining({
        name: "csv-insights",
        description: "Summarize CSV reports.",
        source: "profile",
        modelInvocationEnabled: true,
      }),
    );
    cleanup();
  });

  test("returns empty list when no skills are installed", async () => {
    const { app, cleanup } = freshApp();
    const res = await app.request("/v1/skills");
    expect(res.status).toBe(200);
    expect((await res.json()).items).toEqual([]);
    cleanup();
  });
});
