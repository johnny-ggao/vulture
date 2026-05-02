import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  buildHarnessCiSummary,
  cleanHarnessCiArtifacts,
  harnessRetentionKeepLast,
  runHarnessCiStep,
  runHarnessCiSteps,
  writeHarnessCiSummary,
  type HarnessCiStep,
  type HarnessCiStepResult,
} from "./harnessCi";

describe("harness CI orchestrator", () => {
  test("builds and writes a CI step summary", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-harness-ci-"));
    try {
      const summary = buildHarnessCiSummary(
        [
          step("unit-tests", "Unit tests", "passed", 0),
          step("runtime-harness", "Runtime harness", "failed", 1),
        ],
        "2026-05-02T00:00:00.000Z",
      );
      expect(summary.status).toBe("failed");
      expect(summary.passed).toBe(1);
      expect(summary.failed).toBe(1);

      const paths = writeHarnessCiSummary(dir, summary);
      expect(paths.jsonPath).toBe(join(dir, "ci-summary.json"));
      expect(paths.markdownPath).toBe(join(dir, "ci-summary.md"));
      expect(JSON.parse(readFileSync(paths.jsonPath, "utf8")).status).toBe("failed");
      const markdown = readFileSync(paths.markdownPath, "utf8");
      expect(markdown).toContain("FAILED runtime-harness");
      expect(markdown).toContain("## Failed Steps");
      expect(markdown).toContain("```bash\nbun test\n```");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("includes step errors in CI summary markdown", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-harness-ci-error-"));
    try {
      const summary = buildHarnessCiSummary([
        {
          ...step("spawn-error", "Spawn error", "failed", 1),
          error: "command not found",
        },
      ]);

      writeHarnessCiSummary(dir, summary);
      expect(readFileSync(join(dir, "ci-summary.md"), "utf8")).toContain("command not found");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
    expect(buildHarnessCiSummary(results).status).toBe("failed");
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
});

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
