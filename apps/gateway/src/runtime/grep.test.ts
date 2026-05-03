import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGrep } from "./grep";

const HAS_RIPGREP = spawnSync("rg", ["--version"]).status === 0;
const ripgrepDescribe = HAS_RIPGREP ? describe : describe.skip;

function makeTempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "grep-test-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const foo = 1;\nexport const bar = 2;\n");
  writeFileSync(join(root, "src", "b.ts"), "console.log('foo bar');\n");
  writeFileSync(join(root, "README.md"), "# Foo\nfoo on a markdown line\n");
  return root;
}

describe("runGrep (JS fallback)", () => {
  test("finds literal matches across files", async () => {
    const root = makeTempRepo();
    try {
      const result = await runGrep({
        pattern: "foo",
        path: root,
        regex: false,
        useRipgrep: false,
      });
      const files = new Set(result.matches.map((m) => m.file.replace(root + "/", "")));
      expect(files.has("src/a.ts")).toBe(true);
      expect(files.has("src/b.ts")).toBe(true);
      expect(files.has("README.md")).toBe(true);
      expect(result.truncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("respects caseSensitive=true", async () => {
    const root = makeTempRepo();
    try {
      const result = await runGrep({
        pattern: "Foo",
        path: root,
        regex: false,
        caseSensitive: true,
        useRipgrep: false,
      });
      const matchedTexts = result.matches.map((m) => m.text);
      expect(result.matches.length).toBeGreaterThan(0);
      expect(matchedTexts.some((t) => t.includes("Foo"))).toBe(true);
      expect(matchedTexts.every((t) => !t.toLowerCase().includes("foo bar"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("regex=true treats pattern as regex", async () => {
    const root = makeTempRepo();
    try {
      const result = await runGrep({
        pattern: "^export const ",
        path: root,
        regex: true,
        useRipgrep: false,
      });
      expect(result.matches.length).toBe(2);
      expect(result.matches.every((m) => m.file.endsWith("a.ts"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("truncates at maxMatches", async () => {
    const root = makeTempRepo();
    try {
      const result = await runGrep({
        pattern: "foo",
        path: root,
        regex: false,
        maxMatches: 1,
        useRipgrep: false,
      });
      expect(result.matches.length).toBe(1);
      expect(result.truncated).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("respects glob filter", async () => {
    const root = makeTempRepo();
    try {
      const result = await runGrep({
        pattern: "foo",
        path: root,
        glob: "**/*.ts",
        regex: false,
        useRipgrep: false,
      });
      expect(result.matches.every((m) => m.file.endsWith(".ts"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

ripgrepDescribe("runGrep (ripgrep path)", () => {
  test("ripgrep returns identical match shape to JS fallback", async () => {
    const root = makeTempRepo();
    try {
      const rgResult = await runGrep({ pattern: "foo", path: root, regex: false, useRipgrep: true });
      const jsResult = await runGrep({ pattern: "foo", path: root, regex: false, useRipgrep: false });
      const rgFiles = new Set(rgResult.matches.map((m) => m.file));
      const jsFiles = new Set(jsResult.matches.map((m) => m.file));
      expect(rgFiles).toEqual(jsFiles);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runGrep (auto-detect)", () => {
  test("detectRipgrep returns a boolean", async () => {
    const { detectRipgrep } = await import("./grep");
    const detected = await detectRipgrep();
    expect(typeof detected).toBe("boolean");
  });
});
