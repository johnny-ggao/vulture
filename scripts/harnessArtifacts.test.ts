import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateHarnessArtifactBundle } from "../packages/harness-core/src/index";

describe("harness artifact validation script contract", () => {
  test("fails when required lane artifacts are absent", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-harness-artifacts-script-"));
    try {
      const report = validateHarnessArtifactBundle(root, "2026-05-02T00:00:00.000Z");
      expect(report.status).toBe("failed");
      expect(report.checks.find((check) => check.id === "manifest-runtime")?.status).toBe(
        "failed",
      );
      expect(report.checks.find((check) => check.id === "manifest-desktop-e2e")?.status).toBe(
        "passed",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("validates ci-summary only when present", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-harness-artifacts-script-"));
    try {
      const reportWithoutSummary = validateHarnessArtifactBundle(root, "2026-05-02T00:00:00.000Z");
      expect(reportWithoutSummary.checks.find((check) => check.id === "ci-summary")?.status).toBe(
        "passed",
      );

      mkdirSync(join(root, "harness-report"), { recursive: true });
      writeFileSync(join(root, "harness-report", "ci-summary.json"), "{not-json");
      const reportWithBadSummary = validateHarnessArtifactBundle(root, "2026-05-02T00:00:00.000Z");
      expect(reportWithBadSummary.checks.find((check) => check.id === "ci-summary")?.status).toBe(
        "failed",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
