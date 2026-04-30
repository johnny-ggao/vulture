import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDesktopArtifactRun,
  writeDesktopFailureReport,
  writeDesktopJUnit,
  writeDesktopScenarioSummary,
  writeDesktopSuiteSummary,
} from "./artifacts";

describe("desktop e2e artifacts", () => {
  test("creates per-run artifact directories", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-desktop-e2e-artifacts-"));
    try {
      const run = createDesktopArtifactRun(root, "launch smoke", "fixed/run");

      expect(run.scenarioDir.endsWith("launch-smoke-fixed-run")).toBe(true);
      expect(run.screenshotsDir.endsWith("screenshots")).toBe(true);
      expect(run.logsDir.endsWith("logs")).toBe(true);
      expect(existsSync(run.screenshotsDir)).toBe(true);
      expect(existsSync(run.logsDir)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes suite summary, scenario summary, junit, and failure report", () => {
    const suiteRoot = mkdtempSync(join(tmpdir(), "vulture-desktop-e2e-suite-"));
    const scenarioRoot = mkdtempSync(join(tmpdir(), "vulture-desktop-e2e-scenario-"));
    try {
      const result = {
        id: "launch-smoke",
        name: "Launch <smoke>",
        status: "failed" as const,
        durationMs: 12,
        artifactPath: "/tmp/artifact",
        steps: [
          {
            name: '2. waitForChatReady',
            status: "failed" as const,
            error: "chat & shell not ready",
          },
        ],
      };
      const results = [result];

      expect(writeDesktopSuiteSummary(suiteRoot, results)).toBe(join(suiteRoot, "summary.json"));
      expect(writeDesktopScenarioSummary(scenarioRoot, result)).toBe(join(scenarioRoot, "summary.json"));
      expect(writeDesktopJUnit(suiteRoot, results)).toBe(join(suiteRoot, "junit.xml"));
      expect(writeDesktopFailureReport(suiteRoot, results)).toBe(join(suiteRoot, "failure-report.md"));

      expect(JSON.parse(readFileSync(join(suiteRoot, "summary.json"), "utf8"))).toEqual({
        total: 1,
        passed: 0,
        failed: 1,
        results,
      });
      expect(JSON.parse(readFileSync(join(scenarioRoot, "summary.json"), "utf8"))).toEqual(result);
      expect(readFileSync(join(suiteRoot, "junit.xml"), "utf8")).toContain("2. waitForChatReady: chat &amp; shell not ready");
      expect(readFileSync(join(suiteRoot, "junit.xml"), "utf8")).toContain("chat &amp; shell not ready");
      expect(readFileSync(join(suiteRoot, "junit.xml"), "utf8")).toContain("Launch &lt;smoke&gt;");
      expect(readFileSync(join(suiteRoot, "failure-report.md"), "utf8")).toContain("2. waitForChatReady");
    } finally {
      rmSync(suiteRoot, { recursive: true, force: true });
      rmSync(scenarioRoot, { recursive: true, force: true });
    }
  });

  test("does not write failure report when all scenarios pass", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-desktop-e2e-artifacts-"));
    try {
      const result = {
        id: "launch-smoke",
        name: "Launch smoke",
        status: "passed" as const,
        durationMs: 10,
        artifactPath: "/tmp/artifact",
        steps: [{ name: "waitForChatReady", status: "passed" as const }],
      };

      expect(writeDesktopFailureReport(root, [result])).toBeNull();
      expect(existsSync(join(root, "failure-report.md"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fences multi-line failure errors in markdown reports", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-desktop-e2e-artifacts-"));
    try {
      const result = {
        id: "launch-smoke",
        name: "Launch smoke",
        status: "failed" as const,
        durationMs: 10,
        artifactPath: "/tmp/artifact",
        steps: [
          {
            name: "2. waitForChatReady",
            status: "failed" as const,
            error: "first line\n## not a heading\n```inner fence```",
          },
        ],
      };

      writeDesktopFailureReport(root, [result]);

      expect(readFileSync(join(root, "failure-report.md"), "utf8")).toContain(
        "Error:\n````\nfirst line\n## not a heading\n```inner fence```\n````",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("desktop e2e package exposes runnable skeleton contracts", async () => {
    const cli = await import("./cli");
    const packageJson = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8"));

    expect(typeof cli.main).toBe("function");
    expect(packageJson.scripts.typecheck).toBe("tsc -p tsconfig.json --noEmit");
    expect(packageJson.scripts.build).toBe("bun run typecheck");
    expect(existsSync(join(import.meta.dir, "..", "tsconfig.json"))).toBe(true);
  });

  test("includes additional failed steps in junit and markdown failure outputs", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-desktop-e2e-artifacts-"));
    try {
      const result = {
        id: "launch-smoke",
        name: "Launch smoke",
        status: "failed" as const,
        durationMs: 10,
        artifactPath: "/tmp/artifact",
        steps: [
          { name: '2. sendMessage("boom")', status: "failed" as const, error: "message rejected" },
          { name: "shutdown", status: "failed" as const, error: "shutdown also failed" },
        ],
      };

      writeDesktopJUnit(root, [result]);
      writeDesktopFailureReport(root, [result]);

      const junit = readFileSync(join(root, "junit.xml"), "utf8");
      expect(junit).toContain('message="2. sendMessage(&quot;boom&quot;): message rejected"');
      expect(junit).toContain("Additional failures:");
      expect(junit).toContain("shutdown: shutdown also failed");

      const report = readFileSync(join(root, "failure-report.md"), "utf8");
      expect(report).toContain('Failed step: 2. sendMessage("boom")');
      expect(report).toContain("Additional failures:");
      expect(report).toContain("shutdown");
      expect(report).toContain("shutdown also failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
