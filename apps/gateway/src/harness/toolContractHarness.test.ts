import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoreToolRegistry } from "../tools/coreTools";
import {
  defaultToolContractFixtures,
  filterToolContractFixtures,
  runToolContractHarness,
  summarizeToolContractResults,
} from "./toolContractHarness";

describe("tool contract harness", () => {
  test("covers every core tool with explicit contract fixtures", () => {
    const registryIds = createCoreToolRegistry().list().map((tool) => tool.id).sort();
    const fixtureIds = defaultToolContractFixtures.map((fixture) => fixture.toolId).sort();

    expect(fixtureIds).toEqual(registryIds);
  });

  test("validates core tool contracts and writes deterministic artifacts", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "vulture-tool-contract-"));
    try {
      const results = await runToolContractHarness({
        artifactDir,
        fixtures: filterToolContractFixtures(defaultToolContractFixtures, {
          tools: ["read"],
        }),
        workspacePath: "/tmp/vulture-workspace",
      });

      expect(summarizeToolContractResults(results)).toMatchObject({
        total: 1,
        passed: 1,
        failed: 0,
        status: "passed",
      });
      expect(results[0]?.checks.map((check) => check.name)).toEqual([
        "metadata",
        "schema.valid",
        "schema.invalid",
        "fixture.metadata",
        "approval",
        "sdk.invoke",
      ]);
      expect(results[0]?.checks.every((check) => check.status === "passed")).toBe(true);

      const summary = JSON.parse(readFileSync(join(artifactDir, "summary.json"), "utf8"));
      expect(summary.tools).toEqual([{ id: "read", status: "passed" }]);
      const resultBody = JSON.parse(readFileSync(join(artifactDir, "results.json"), "utf8"));
      expect(resultBody[0].toolId).toBe("read");
      expect(existsSync(join(artifactDir, "failure-report.md"))).toBe(false);
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  test("reports contract failures with actionable messages", async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), "vulture-tool-contract-"));
    try {
      const readFixture = defaultToolContractFixtures.find((fixture) => fixture.toolId === "read");
      expect(readFixture).toBeDefined();

      const results = await runToolContractHarness({
        artifactDir,
        fixtures: [{ ...readFixture!, expectedIdempotent: false }],
        workspacePath: "/tmp/vulture-workspace",
      });

      expect(results[0]?.status).toBe("failed");
      expect(readFileSync(join(artifactDir, "failure-report.md"), "utf8")).toContain(
        "expected idempotent false, got true",
      );
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  test("filters fixtures by tool ids and categories", () => {
    expect(
      filterToolContractFixtures(defaultToolContractFixtures, {
        tools: ["read", "write"],
      }).map((fixture) => fixture.toolId),
    ).toEqual(["read", "write"]);

    expect(
      filterToolContractFixtures(defaultToolContractFixtures, {
        categories: ["sessions"],
      }).map((fixture) => fixture.toolId),
    ).toEqual([
      "sessions_list",
      "sessions_history",
      "sessions_send",
      "sessions_spawn",
      "sessions_yield",
    ]);

    expect(() =>
      filterToolContractFixtures(defaultToolContractFixtures, {
        tools: ["missing"],
      }),
    ).toThrow("Unknown tool contract fixture: missing");
  });
});
