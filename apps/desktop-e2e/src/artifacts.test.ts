import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDesktopArtifactRun,
  writeDesktopFailureReport,
  writeDesktopJUnit,
  writeDesktopSummary,
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

  test("writes summary, junit, and failure report", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-desktop-e2e-artifacts-"));
    try {
      const results = [
        {
          id: "launch-smoke",
          name: "Launch <smoke>",
          status: "failed" as const,
          durationMs: 12,
          artifactPath: "/tmp/artifact",
          steps: [
            {
              name: "waitForChatReady",
              status: "failed" as const,
              error: "chat & shell not ready",
            },
          ],
        },
      ];

      expect(writeDesktopSummary(root, results)).toBe(join(root, "summary.json"));
      expect(writeDesktopJUnit(root, results)).toBe(join(root, "junit.xml"));
      expect(writeDesktopFailureReport(root, results)).toBe(join(root, "failure-report.md"));

      expect(readFileSync(join(root, "summary.json"), "utf8")).toContain("launch-smoke");
      expect(readFileSync(join(root, "junit.xml"), "utf8")).toContain("chat &amp; shell not ready");
      expect(readFileSync(join(root, "junit.xml"), "utf8")).toContain("Launch &lt;smoke&gt;");
      expect(readFileSync(join(root, "failure-report.md"), "utf8")).toContain("waitForChatReady");
    } finally {
      rmSync(root, { recursive: true, force: true });
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
});
