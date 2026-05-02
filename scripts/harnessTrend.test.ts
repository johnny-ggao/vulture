import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HarnessReport } from "@vulture/harness-core";
import {
  buildHarnessTrend,
  parseHarnessTrendLimit,
  readHarnessTrendSnapshots,
  writeHarnessTrendReport,
  type HarnessTrendSnapshot,
} from "./harnessTrend";

describe("harness trend analyzer", () => {
  test("computes step P50/P95, pass rate, lane stats, and flake candidates", () => {
    const trend = buildHarnessTrend({
      archiveRoot: "/tmp/archive",
      generatedAt: "2026-05-03T00:00:00.000Z",
      snapshots: [
        snapshot("run-1", "2026-05-01T00:00:00.000Z", "passed", {
          steps: [step("unit", "passed", 100), step("acceptance", "passed", 200)],
          lanes: [lane("runtime", "passed"), lane("acceptance", "passed")],
        }),
        snapshot("run-2", "2026-05-02T00:00:00.000Z", "failed", {
          steps: [step("unit", "passed", 110), step("acceptance", "failed", 250)],
          lanes: [lane("runtime", "passed"), lane("acceptance", "failed")],
        }),
        snapshot("run-3", "2026-05-03T00:00:00.000Z", "passed", {
          steps: [step("unit", "passed", 90), step("acceptance", "passed", 220)],
          lanes: [lane("runtime", "passed"), lane("acceptance", "passed")],
        }),
      ],
    });

    expect(trend.window).toBe(3);
    expect(trend.earliest).toBe("2026-05-01T00:00:00.000Z");
    expect(trend.latest).toBe("2026-05-03T00:00:00.000Z");
    expect(trend.runs.map((run) => run.id)).toEqual(["run-3", "run-2", "run-1"]);

    const unit = trend.steps.find((entry) => entry.id === "unit");
    const acceptance = trend.steps.find((entry) => entry.id === "acceptance");
    expect(unit).toMatchObject({
      runs: 3,
      passed: 3,
      failed: 0,
      passRate: 1,
      maxMs: 110,
    });
    expect(acceptance).toMatchObject({
      runs: 3,
      passed: 2,
      failed: 1,
      maxMs: 250,
    });
    expect(acceptance!.passRate).toBeCloseTo(2 / 3);

    const acceptanceLane = trend.lanes.find((entry) => entry.lane === "acceptance");
    expect(acceptanceLane).toMatchObject({ passed: 2, failed: 1, missing: 0 });
    expect(acceptanceLane!.passRate).toBeCloseTo(2 / 3);

    expect(trend.flakeCandidates).toEqual([
      {
        stepId: "acceptance",
        pattern: "pass->fail->pass",
        runs: ["run-1", "run-2", "run-3"],
      },
    ]);
  });

  test("reports missing lane snapshots without counting them in pass rate", () => {
    const trend = buildHarnessTrend({
      archiveRoot: "/tmp/archive",
      generatedAt: "2026-05-03T00:00:00.000Z",
      snapshots: [
        snapshot("run-1", "2026-05-01T00:00:00.000Z", "passed", {
          steps: [],
          lanes: [lane("runtime", "passed"), { lane: "desktop-e2e", status: "missing", total: 0, passed: 0, failed: 0 }],
        }),
        snapshot("run-2", "2026-05-02T00:00:00.000Z", "passed", {
          steps: [],
          lanes: [lane("runtime", "passed"), { lane: "desktop-e2e", status: "missing", total: 0, passed: 0, failed: 0 }],
        }),
      ],
    });
    const desktop = trend.lanes.find((entry) => entry.lane === "desktop-e2e");
    expect(desktop).toMatchObject({ passed: 0, failed: 0, missing: 2 });
    expect(desktop!.passRate).toBeNull();
  });

  test("ignores three-fail-in-a-row as ongoing failure (not a flake)", () => {
    const trend = buildHarnessTrend({
      archiveRoot: "/tmp/archive",
      snapshots: [
        snapshot("r1", "2026-05-01T00:00:00.000Z", "failed", {
          steps: [step("broken", "failed", 100)],
          lanes: [],
        }),
        snapshot("r2", "2026-05-02T00:00:00.000Z", "failed", {
          steps: [step("broken", "failed", 100)],
          lanes: [],
        }),
        snapshot("r3", "2026-05-03T00:00:00.000Z", "failed", {
          steps: [step("broken", "failed", 100)],
          lanes: [],
        }),
      ],
    });
    expect(trend.flakeCandidates).toEqual([]);
  });

  test("parses trend limit conservatively", () => {
    expect(parseHarnessTrendLimit(undefined)).toBe(30);
    expect(parseHarnessTrendLimit("")).toBe(30);
    expect(parseHarnessTrendLimit("10")).toBe(10);
    expect(parseHarnessTrendLimit("0")).toBe(30);
    expect(parseHarnessTrendLimit("-5")).toBe(30);
    expect(parseHarnessTrendLimit("not-a-number")).toBe(30);
    expect(parseHarnessTrendLimit("12.7")).toBe(12);
  });

  test("reads only valid v2 snapshots and respects limit", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-trend-"));
    try {
      writeReportSnapshot(root, "run-old", reportFixture("2026-05-01T00:00:00.000Z", "passed"));
      writeReportSnapshot(root, "run-new", reportFixture("2026-05-02T00:00:00.000Z", "failed"));
      writeReportSnapshot(root, "run-bad-version", { ...reportFixture("2026-05-03T00:00:00.000Z", "passed"), schemaVersion: 1 } as unknown as HarnessReport);
      writeReportSnapshot(root, "run-malformed", undefined, "{not-json");
      mkdirSync(join(root, "not-a-snapshot"), { recursive: true }); // no harness-report inside

      const all = readHarnessTrendSnapshots(root, 30);
      expect(all.map((entry) => entry.id)).toEqual(["run-new", "run-old"]);

      const capped = readHarnessTrendSnapshots(root, 1);
      expect(capped.map((entry) => entry.id)).toEqual(["run-new"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("writes trend.json and trend.md with expected sections", () => {
    const root = mkdtempSync(join(tmpdir(), "vulture-trend-write-"));
    try {
      const trend = buildHarnessTrend({
        archiveRoot: "/tmp/archive",
        generatedAt: "2026-05-03T00:00:00.000Z",
        snapshots: [
          snapshot("run-1", "2026-05-01T00:00:00.000Z", "passed", {
            steps: [step("unit", "passed", 50)],
            lanes: [lane("runtime", "passed")],
          }),
        ],
      });
      const paths = writeHarnessTrendReport(root, trend);
      expect(paths.jsonPath).toBe(join(root, "trend.json"));
      expect(paths.markdownPath).toBe(join(root, "trend.md"));
      const json = JSON.parse(readFileSync(paths.jsonPath, "utf8"));
      expect(json.schemaVersion).toBe(1);
      expect(json.window).toBe(1);
      const markdown = readFileSync(paths.markdownPath, "utf8");
      expect(markdown).toContain("# Harness Trend");
      expect(markdown).toContain("## Step durations and pass rate");
      expect(markdown).toContain("## Lane pass rate");
      expect(markdown).toContain("## Flake candidates");
      expect(markdown).toContain("No pass->fail->pass patterns detected.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function snapshot(
  id: string,
  generatedAt: string,
  status: "passed" | "failed",
  body: { steps: ReturnType<typeof step>[]; lanes: HarnessReport["lanes"] },
): HarnessTrendSnapshot {
  return {
    id,
    generatedAt,
    status,
    report: {
      schemaVersion: 2,
      generatedAt,
      status,
      lanes: body.lanes,
      missingRequiredLanes: [],
      missingOptionalLanes: [],
      doctor: null,
      ci: {
        status: body.steps.some((entry) => entry.status === "failed") ? "failed" : "passed",
        total: body.steps.length,
        passed: body.steps.filter((entry) => entry.status === "passed").length,
        failed: body.steps.filter((entry) => entry.status === "failed").length,
        steps: body.steps,
      },
      artifactValidation: null,
      failures: { summary: { total: 0, ciSteps: 0, lanes: 0, artifactValidation: 0 }, items: [] },
    },
  };
}

function step(id: string, status: "passed" | "failed", durationMs: number) {
  return {
    id,
    name: id,
    command: ["bun", "test"],
    status,
    exitCode: status === "passed" ? 0 : 1,
    signal: null,
    durationMs,
  };
}

function lane(name: string, status: "passed" | "failed"): HarnessReport["lanes"][number] {
  return {
    lane: name,
    status,
    total: 1,
    passed: status === "passed" ? 1 : 0,
    failed: status === "failed" ? 1 : 0,
  };
}

function reportFixture(generatedAt: string, status: "passed" | "failed"): HarnessReport {
  return {
    schemaVersion: 2,
    generatedAt,
    status,
    lanes: [],
    missingRequiredLanes: [],
    missingOptionalLanes: [],
    doctor: null,
    ci: { status, total: 0, passed: 0, failed: 0, steps: [] },
    artifactValidation: null,
    failures: { summary: { total: 0, ciSteps: 0, lanes: 0, artifactValidation: 0 }, items: [] },
  };
}

function writeReportSnapshot(root: string, id: string, report?: HarnessReport, raw?: string): void {
  const dir = join(root, id, "harness-report");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "report.json");
  writeFileSync(path, raw ?? `${JSON.stringify(report)}\n`);
}
