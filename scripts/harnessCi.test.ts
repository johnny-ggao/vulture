import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  cleanHarnessCiArtifacts,
  harnessRetentionKeepLast,
  renderHarnessGithubStepSummary,
  runHarnessCiStep,
  runHarnessCiSteps,
  writeHarnessGithubStepSummaryIfConfigured,
  type HarnessCiStep,
  type HarnessCiStepResult,
  type HarnessGithubStepSummaryInput,
} from "./harnessCi";
import type { HarnessReport } from "@vulture/harness-core";

describe("harness CI orchestrator", () => {
  test("continues running later steps after an earlier step fails", () => {
    const steps: HarnessCiStep[] = [
      { id: "first", name: "First", command: ["first"] },
      { id: "second", name: "Second", command: ["second"] },
      { id: "report", name: "Report", command: ["report"] },
    ];
    const invoked: string[] = [];

    const results = runHarnessCiSteps(steps, "/tmp/workspace", (stepToRun) => {
      invoked.push(stepToRun.id);
      return step(
        stepToRun.id,
        stepToRun.name,
        stepToRun.id === "first" ? "failed" : "passed",
        stepToRun.id === "first" ? 1 : 0,
      );
    });

    expect(invoked).toEqual(["first", "second", "report"]);
    expect(results.filter((r) => r.status === "passed")).toHaveLength(2);
    expect(results.filter((r) => r.status === "failed")).toHaveLength(1);
  });

  test("reports empty CI step commands as failed without spawning", () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        runHarnessCiStep({ id: "empty", name: "Empty", command: [] }, "/tmp/workspace"),
      ).toMatchObject({
        id: "empty",
        status: "failed",
        exitCode: null,
        error: "Harness CI step has no command",
      });
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  test("cleans only harness CI artifact directories", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-harness-ci-artifacts-"));
    try {
      writeFile(join(root, "runtime-harness", "manifest.json"));
      writeFile(join(root, "tool-contract-harness", "manifest.json"));
      writeFile(join(root, "acceptance", "manifest.json"));
      writeFile(join(root, "harness-catalog", "doctor.json"));
      writeFile(join(root, "harness-report", "report.json"));
      writeFile(join(root, "harness-runs", "run-1", "retention-manifest.json"));
      writeFile(join(root, "desktop-e2e", "summary.json"));

      cleanHarnessCiArtifacts(root);

      expect(existsSync(join(root, "runtime-harness"))).toBe(false);
      expect(existsSync(join(root, "tool-contract-harness"))).toBe(false);
      expect(existsSync(join(root, "acceptance"))).toBe(false);
      expect(existsSync(join(root, "harness-catalog"))).toBe(false);
      expect(existsSync(join(root, "harness-report"))).toBe(false);
      expect(existsSync(join(root, "harness-runs", "run-1", "retention-manifest.json"))).toBe(true);
      expect(existsSync(join(root, "desktop-e2e", "summary.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parses retention keep-last environment values conservatively", () => {
    expect(harnessRetentionKeepLast({})).toBe(5);
    expect(harnessRetentionKeepLast({ VULTURE_HARNESS_RETENTION_KEEP_LAST: "2" })).toBe(2);
    expect(harnessRetentionKeepLast({ VULTURE_HARNESS_RETENTION_KEEP_LAST: "2.9" })).toBe(2);
    expect(harnessRetentionKeepLast({ VULTURE_HARNESS_RETENTION_KEEP_LAST: "-1" })).toBe(5);
    expect(harnessRetentionKeepLast({ VULTURE_HARNESS_RETENTION_KEEP_LAST: "bad" })).toBe(5);
  });

  test("renders a GitHub step summary with failures and key artifacts", () => {
    const markdown = renderHarnessGithubStepSummary({
      artifactRoot: "/tmp/vulture/.artifacts",
      report: failingReport(),
      bundleManifest: {
        schemaVersion: 1,
        generatedAt: "2026-05-02T00:00:00.000Z",
        artifactRoot: "/tmp/vulture/.artifacts",
        fileCount: 42,
        totalBytes: 100,
        requiredFiles: [{ path: "harness-report/report.json", status: "missing" }],
        files: [],
      },
      history: {
        schemaVersion: 1,
        generatedAt: "2026-05-02T00:00:00.000Z",
        archiveRoot: "/tmp/vulture/.artifacts/harness-runs",
        latestStatus: "failed",
        total: 1,
        entries: [{
          id: "run-1",
          path: "/tmp/vulture/.artifacts/harness-runs/run-1",
          generatedAt: "2026-05-02T00:00:00.000Z",
          status: "failed",
          artifactDirs: ["harness-report"],
          retentionReasons: ["recent"],
        }],
      },
    });

    expect(markdown).toContain("# Vulture Harness CI");
    expect(markdown).toContain("Steps: 1/2 passed");
    expect(markdown).toContain("Missing required files: 1");
    expect(markdown).toContain("Latest snapshot: run-1 (failed)");
    expect(markdown).toContain("```bash\nbun run harness:runtime\n```");
    expect(markdown).toContain("Report: /tmp/vulture/.artifacts/harness-report/report.md");
  });

  test("writes GitHub step summary only when configured", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-github-summary-"));
    try {
      const path = join(root, "summary.md");
      const input: HarnessGithubStepSummaryInput = {
        artifactRoot: "/tmp/vulture/.artifacts",
        report: passingReport(),
        bundleManifest: {
          schemaVersion: 1,
          generatedAt: "2026-05-02T00:00:00.000Z",
          artifactRoot: "/tmp/vulture/.artifacts",
          fileCount: 1,
          totalBytes: 1,
          requiredFiles: [],
          files: [],
        },
        history: {
          schemaVersion: 1,
          generatedAt: "2026-05-02T00:00:00.000Z",
          archiveRoot: "/tmp/vulture/.artifacts/harness-runs",
          latestStatus: "none",
          total: 0,
          entries: [],
        },
      };

      expect(writeHarnessGithubStepSummaryIfConfigured({}, input)).toBeNull();
      expect(existsSync(path)).toBe(false);
      expect(writeHarnessGithubStepSummaryIfConfigured({ GITHUB_STEP_SUMMARY: path }, input)).toBe(path);
      expect(readFileSync(path, "utf8")).toContain("No failures.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function failingReport(): HarnessReport {
  return {
    schemaVersion: 2,
    generatedAt: "2026-05-02T00:00:00.000Z",
    status: "failed",
    lanes: [],
    missingRequiredLanes: [],
    missingOptionalLanes: [],
    doctor: null,
    ci: {
      status: "failed",
      total: 2,
      passed: 1,
      failed: 1,
      steps: [
        {
          id: "runtime-harness",
          name: "Runtime harness",
          command: ["bun", "run", "harness:runtime"],
          status: "failed",
          exitCode: 1,
          signal: null,
          durationMs: 42,
          error: "runtime failed",
        },
        {
          id: "harness-report",
          name: "Harness report",
          command: ["bun", "run", "harness:report"],
          status: "passed",
          exitCode: 0,
          signal: null,
          durationMs: 42,
        },
      ],
    },
    artifactValidation: {
      status: "failed",
      total: 1,
      passed: 0,
      failed: 1,
      checks: [
        {
          id: "junit-runtime",
          status: "failed",
          detail: "junit drift",
          path: "/tmp/junit.xml",
          command: "bun run harness:runtime",
        },
      ],
    },
    failures: {
      summary: { total: 1, ciSteps: 1, lanes: 0, artifactValidation: 0 },
      items: [{
        category: "ci-step",
        id: "runtime-harness",
        title: "Runtime harness",
        detail: "runtime failed",
        command: "bun run harness:runtime",
      }],
    },
  };
}

function passingReport(): HarnessReport {
  return {
    schemaVersion: 2,
    generatedAt: "2026-05-02T00:00:00.000Z",
    status: "passed",
    lanes: [],
    missingRequiredLanes: [],
    missingOptionalLanes: [],
    doctor: null,
    ci: {
      status: "passed",
      total: 1,
      passed: 1,
      failed: 0,
      steps: [{
        id: "harness-report",
        name: "Harness report",
        command: ["bun", "run", "harness:report"],
        status: "passed",
        exitCode: 0,
        signal: null,
        durationMs: 42,
      }],
    },
    artifactValidation: null,
    failures: {
      summary: { total: 0, ciSteps: 0, lanes: 0, artifactValidation: 0 },
      items: [],
    },
  };
}

function step(
  id: string,
  name: string,
  status: HarnessCiStepResult["status"],
  exitCode: number,
): HarnessCiStepResult {
  return {
    id,
    name,
    command: ["bun", "test"],
    status,
    exitCode,
    signal: null,
    durationMs: 42,
  };
}

function writeFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "ok\n");
}
