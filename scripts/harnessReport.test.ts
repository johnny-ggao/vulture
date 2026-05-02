import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { collectHarnessReportInput } from "./harnessReport";
import type { HarnessArtifactManifest, HarnessDoctorReport } from "@vulture/harness-core";

describe("harness report script", () => {
  test("collects required manifests, optional manifests, and doctor output", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-harness-report-script-"));
    try {
      writeJson(join(root, "runtime-harness", "manifest.json"), manifest("runtime"));
      writeJson(join(root, "tool-contract-harness", "manifest.json"), manifest("tool-contract"));
      writeJson(join(root, "acceptance", "manifest.json"), manifest("acceptance"));
      writeJson(join(root, "harness-catalog", "doctor.json"), doctor());

      const input = collectHarnessReportInput(root);
      expect(input.requiredLanes).toEqual(["runtime", "tool-contract", "acceptance"]);
      expect(input.optionalLanes).toEqual(["desktop-e2e"]);
      expect(input.manifests.map((item) => item.lane)).toEqual([
        "runtime",
        "tool-contract",
        "acceptance",
      ]);
      expect(input.doctor?.status).toBe("passed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function manifest(lane: HarnessArtifactManifest["lane"]): HarnessArtifactManifest {
  return {
    schemaVersion: 1,
    generatedAt: "2026-05-02T00:00:00.000Z",
    lane,
    status: "passed",
    total: 1,
    passed: 1,
    failed: 0,
    results: [{ id: `${lane}-scenario`, name: lane, status: "passed" }],
  };
}

function doctor(): HarnessDoctorReport {
  return {
    schemaVersion: 1,
    generatedAt: "2026-05-02T00:00:00.000Z",
    status: "passed",
    summary: { laneCount: 3, scenarioCount: 3, tagCount: 1 },
    checks: [{ id: "metadata", name: "Metadata", status: "passed", detail: "ok" }],
  };
}
