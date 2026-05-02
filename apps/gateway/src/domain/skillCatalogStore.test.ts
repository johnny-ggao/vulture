import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillCatalogStore } from "./skillCatalogStore";

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "vulture-skill-catalog-store-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function writeSkill(dir: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    [
      "---",
      "name: csv-insights",
      "description: Analyze CSV files",
      `version: ${version}`,
      "---",
      "",
      "Use this for CSV analysis.",
      "",
    ].join("\n"),
  );
}

describe("SkillCatalogStore lifecycle", () => {
  test("marks installed catalog entries outdated when package version advances", () => {
    const { dir, cleanup } = tempDir();
    const packageDir = join(dir, "packages", "csv-insights");
    writeSkill(packageDir, "1.0.0");
    const store = new SkillCatalogStore(dir);

    store.importPackage({ packagePath: packageDir });
    expect(store.install("csv-insights")).toMatchObject({
      lifecycleStatus: "installed",
      installedVersion: "1.0.0",
      needsUpdate: false,
      lastError: null,
    });

    writeSkill(packageDir, "1.1.0");
    store.importPackage({ packagePath: packageDir });

    expect(store.get("csv-insights")).toMatchObject({
      lifecycleStatus: "outdated",
      version: "1.1.0",
      installedVersion: "1.0.0",
      needsUpdate: true,
    });
    cleanup();
  });

  test("records failed installs and clears the error after a successful retry", () => {
    const { dir, cleanup } = tempDir();
    const packageDir = join(dir, "packages", "csv-insights");
    writeSkill(packageDir, "1.0.0");
    const store = new SkillCatalogStore(dir);
    store.importPackage({ packagePath: packageDir });
    rmSync(packageDir, { recursive: true, force: true });

    expect(() => store.install("csv-insights")).toThrow("packagePath must be an existing directory");
    expect(store.get("csv-insights")).toMatchObject({
      lifecycleStatus: "failed",
      installed: false,
      lastError: expect.stringContaining("packagePath must be an existing directory"),
    });

    writeSkill(packageDir, "1.0.0");
    expect(store.install("csv-insights")).toMatchObject({
      lifecycleStatus: "installed",
      installedVersion: "1.0.0",
      lastError: null,
    });
    cleanup();
  });
});
