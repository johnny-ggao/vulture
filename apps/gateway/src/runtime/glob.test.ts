import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGlob } from "./glob";

function makeTempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "glob-test-"));
  mkdirSync(join(root, "src", "nested"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "");
  writeFileSync(join(root, "src", "b.tsx"), "");
  writeFileSync(join(root, "src", "nested", "c.ts"), "");
  writeFileSync(join(root, "src", "d.js"), "");
  writeFileSync(join(root, "README.md"), "");
  return root;
}

describe("runGlob", () => {
  test("matches recursive ts pattern", async () => {
    const root = makeTempRepo();
    try {
      const result = await runGlob({ pattern: "**/*.ts", path: root });
      const rels = result.paths.map((p) => p.replace(root + "/", "")).sort();
      expect(rels).toEqual(["src/a.ts", "src/nested/c.ts"]);
      expect(result.truncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("matches multiple extensions via brace", async () => {
    const root = makeTempRepo();
    try {
      const result = await runGlob({ pattern: "**/*.{ts,tsx}", path: root });
      expect(result.paths.length).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("respects maxResults", async () => {
    const root = makeTempRepo();
    try {
      const result = await runGlob({ pattern: "**/*", path: root, maxResults: 2 });
      expect(result.paths.length).toBe(2);
      expect(result.truncated).toBe(true);
      result.paths.forEach((p) => expect(p.startsWith(root)).toBe(true));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
