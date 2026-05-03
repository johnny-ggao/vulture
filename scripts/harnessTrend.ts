import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  findHarnessRepoRoot,
  type HarnessReport,
  type HarnessStatus,
} from "@vulture/harness-core";

export interface HarnessTrendSnapshot {
  id: string;
  generatedAt: string;
  status: HarnessStatus;
  report: HarnessReport;
}

export interface HarnessTrendStepStat {
  id: string;
  runs: number;
  passed: number;
  failed: number;
  passRate: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

export interface HarnessTrendLaneStat {
  lane: string;
  passed: number;
  failed: number;
  missing: number;
  passRate: number | null;
}

export interface HarnessTrendFlakeCandidate {
  stepId: string;
  pattern: "pass->fail->pass";
  runs: [string, string, string];
}

export interface HarnessTrendStepRegression {
  stepId: string;
  runId: string;
  currentMs: number;
  baselineP50Ms: number;
  thresholdMs: number;
  ratio: number;
  detail: string;
}

/**
 * Threshold multiplier for the latest snapshot's duration vs the rest of the
 * window's baseline P50. 2× is conservative on purpose: real regressions
 * (cold cache, infra change, new dependency) reliably exceed 2×, while
 * normal run-to-run noise stays under it.
 */
export const HARNESS_TREND_REGRESSION_RATIO = 2;

export interface HarnessTrendReport {
  schemaVersion: 1;
  generatedAt: string;
  archiveRoot: string;
  window: number;
  earliest: string | null;
  latest: string | null;
  runs: Array<{ id: string; generatedAt: string; status: HarnessStatus }>;
  steps: HarnessTrendStepStat[];
  lanes: HarnessTrendLaneStat[];
  flakeCandidates: HarnessTrendFlakeCandidate[];
  regressions: HarnessTrendStepRegression[];
}

export interface BuildHarnessTrendInput {
  snapshots: readonly HarnessTrendSnapshot[];
  archiveRoot: string;
  generatedAt?: string;
}

export function buildHarnessTrend(input: BuildHarnessTrendInput): HarnessTrendReport {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const sorted = [...input.snapshots].sort((left, right) =>
    right.generatedAt.localeCompare(left.generatedAt),
  );
  return {
    schemaVersion: 1,
    generatedAt,
    archiveRoot: input.archiveRoot,
    window: sorted.length,
    earliest: sorted.length > 0 ? sorted[sorted.length - 1]!.generatedAt : null,
    latest: sorted.length > 0 ? sorted[0]!.generatedAt : null,
    runs: sorted.map((snap) => ({
      id: snap.id,
      generatedAt: snap.generatedAt,
      status: snap.status,
    })),
    steps: computeStepStats(sorted),
    lanes: computeLaneStats(sorted),
    flakeCandidates: detectFlakeCandidates(sorted),
    regressions: detectRegressions(sorted),
  };
}

function detectRegressions(
  snapshots: readonly HarnessTrendSnapshot[],
): HarnessTrendStepRegression[] {
  if (snapshots.length < 2) return [];
  const [latest, ...baseline] = snapshots; // newest-first ordering
  if (!latest) return [];

  const baselineDurations = new Map<string, number[]>();
  for (const snap of baseline) {
    for (const step of snap.report.ci?.steps ?? []) {
      if (typeof step.durationMs !== "number") continue;
      const arr = baselineDurations.get(step.id) ?? [];
      arr.push(step.durationMs);
      baselineDurations.set(step.id, arr);
    }
  }

  const regressions: HarnessTrendStepRegression[] = [];
  for (const step of latest.report.ci?.steps ?? []) {
    if (typeof step.durationMs !== "number") continue;
    const samples = baselineDurations.get(step.id);
    if (!samples || samples.length === 0) continue;
    const sortedSamples = [...samples].sort((left, right) => left - right);
    const baselineP50 = quantile(sortedSamples, 0.5);
    if (baselineP50 <= 0) continue;
    const threshold = baselineP50 * HARNESS_TREND_REGRESSION_RATIO;
    if (step.durationMs <= threshold) continue;
    const ratio = step.durationMs / baselineP50;
    regressions.push({
      stepId: step.id,
      runId: latest.id,
      currentMs: step.durationMs,
      baselineP50Ms: baselineP50,
      thresholdMs: threshold,
      ratio,
      detail: `latest run took ${Math.round(step.durationMs)}ms, ${ratio.toFixed(2)}× baseline P50 ${Math.round(baselineP50)}ms (threshold ${Math.round(threshold)}ms)`,
    });
  }
  return regressions.sort((left, right) => left.stepId.localeCompare(right.stepId));
}

export function readHarnessTrendSnapshots(
  archiveRoot: string,
  limit: number,
): HarnessTrendSnapshot[] {
  if (!existsSync(archiveRoot)) return [];
  const entries = readdirSync(archiveRoot)
    .map((id) => {
      const dir = join(archiveRoot, id);
      if (!statSync(dir).isDirectory()) return null;
      const reportPath = join(dir, "harness-report", "report.json");
      if (!existsSync(reportPath)) return null;
      try {
        const report = JSON.parse(readFileSync(reportPath, "utf8")) as HarnessReport;
        if (report.schemaVersion !== 2) return null;
        const status: HarnessStatus = report.status === "failed" ? "failed" : "passed";
        return { id, generatedAt: report.generatedAt, status, report };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is HarnessTrendSnapshot => entry !== null)
    .sort((left, right) => right.generatedAt.localeCompare(left.generatedAt));
  return entries.slice(0, limit);
}

export function writeHarnessTrendReport(
  reportDir: string,
  trend: HarnessTrendReport,
): { jsonPath: string; markdownPath: string } {
  mkdirSync(reportDir, { recursive: true });
  const jsonPath = join(reportDir, "trend.json");
  const markdownPath = join(reportDir, "trend.md");
  writeFileSync(jsonPath, `${JSON.stringify(trend, null, 2)}\n`);
  writeFileSync(markdownPath, renderTrendMarkdown(trend));
  return { jsonPath, markdownPath };
}

function computeStepStats(
  snapshots: readonly HarnessTrendSnapshot[],
): HarnessTrendStepStat[] {
  const byStep = new Map<string, { durations: number[]; passed: number; failed: number }>();
  for (const snap of snapshots) {
    for (const step of snap.report.ci?.steps ?? []) {
      const acc = byStep.get(step.id) ?? { durations: [], passed: 0, failed: 0 };
      if (typeof step.durationMs === "number") acc.durations.push(step.durationMs);
      if (step.status === "passed") acc.passed += 1;
      else acc.failed += 1;
      byStep.set(step.id, acc);
    }
  }
  return [...byStep.entries()]
    .map(([id, acc]) => {
      const sortedDurations = [...acc.durations].sort((left, right) => left - right);
      const total = acc.passed + acc.failed;
      return {
        id,
        runs: total,
        passed: acc.passed,
        failed: acc.failed,
        passRate: total === 0 ? 0 : acc.passed / total,
        p50Ms: quantile(sortedDurations, 0.5),
        p95Ms: quantile(sortedDurations, 0.95),
        maxMs: sortedDurations.length > 0 ? sortedDurations[sortedDurations.length - 1]! : 0,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function computeLaneStats(
  snapshots: readonly HarnessTrendSnapshot[],
): HarnessTrendLaneStat[] {
  const byLane = new Map<string, { passed: number; failed: number; missing: number }>();
  for (const snap of snapshots) {
    for (const lane of snap.report.lanes) {
      const acc = byLane.get(lane.lane) ?? { passed: 0, failed: 0, missing: 0 };
      if (lane.status === "passed") acc.passed += 1;
      else if (lane.status === "failed") acc.failed += 1;
      else acc.missing += 1;
      byLane.set(lane.lane, acc);
    }
  }
  return [...byLane.entries()]
    .map(([lane, acc]) => {
      const decided = acc.passed + acc.failed;
      return {
        lane,
        passed: acc.passed,
        failed: acc.failed,
        missing: acc.missing,
        passRate: decided === 0 ? null : acc.passed / decided,
      };
    })
    .sort((left, right) => left.lane.localeCompare(right.lane));
}

function detectFlakeCandidates(
  snapshots: readonly HarnessTrendSnapshot[],
): HarnessTrendFlakeCandidate[] {
  const ordered = [...snapshots].sort((left, right) =>
    left.generatedAt.localeCompare(right.generatedAt),
  );
  const byStep = new Map<string, Array<{ runId: string; status: HarnessStatus }>>();
  for (const snap of ordered) {
    for (const step of snap.report.ci?.steps ?? []) {
      const arr = byStep.get(step.id) ?? [];
      arr.push({ runId: snap.id, status: step.status });
      byStep.set(step.id, arr);
    }
  }
  const candidates: HarnessTrendFlakeCandidate[] = [];
  for (const [stepId, sequence] of byStep.entries()) {
    if (sequence.length < 3) continue;
    for (let index = 1; index < sequence.length - 1; index += 1) {
      const previous = sequence[index - 1]!;
      const current = sequence[index]!;
      const next = sequence[index + 1]!;
      if (
        current.status === "failed" &&
        previous.status === "passed" &&
        next.status === "passed"
      ) {
        candidates.push({
          stepId,
          pattern: "pass->fail->pass",
          runs: [previous.runId, current.runId, next.runId],
        });
      }
    }
  }
  return candidates;
}

function quantile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = (sorted.length - 1) * probability;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function renderTrendMarkdown(trend: HarnessTrendReport): string {
  const lines = [
    "# Harness Trend",
    "",
    `Generated: ${trend.generatedAt}`,
    `Archive root: ${trend.archiveRoot}`,
    `Window: ${trend.window} snapshots`,
    `Range: ${trend.earliest ?? "n/a"} -> ${trend.latest ?? "n/a"}`,
    "",
    "## Step durations and pass rate",
    "",
    "| Step | Runs | Pass rate | P50 (ms) | P95 (ms) | Max (ms) |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const step of trend.steps) {
    lines.push(
      `| ${step.id} | ${step.runs} | ${(step.passRate * 100).toFixed(1)}% | ${Math.round(step.p50Ms)} | ${Math.round(step.p95Ms)} | ${Math.round(step.maxMs)} |`,
    );
  }
  lines.push(
    "",
    "## Lane pass rate",
    "",
    "| Lane | Passed | Failed | Missing | Pass rate |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const lane of trend.lanes) {
    const rate = lane.passRate === null ? "n/a" : `${(lane.passRate * 100).toFixed(1)}%`;
    lines.push(`| ${lane.lane} | ${lane.passed} | ${lane.failed} | ${lane.missing} | ${rate} |`);
  }
  lines.push("", "## Flake candidates", "");
  if (trend.flakeCandidates.length === 0) {
    lines.push("No pass->fail->pass patterns detected.");
  } else {
    for (const candidate of trend.flakeCandidates) {
      lines.push(
        `- ${candidate.stepId}: ${candidate.pattern} across runs ${candidate.runs.join(", ")}`,
      );
    }
  }
  lines.push(
    "",
    "## Regressions",
    "",
    `Threshold: latest run > ${HARNESS_TREND_REGRESSION_RATIO}× baseline P50 (rest of window)`,
    "",
  );
  if (trend.regressions.length === 0) {
    lines.push("No regressions detected.");
  } else {
    for (const regression of trend.regressions) {
      lines.push(`- ${regression.stepId}: ${regression.detail}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function parseHarnessTrendLimit(raw: string | undefined): number {
  if (!raw) return 30;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 30;
  return Math.floor(value);
}

async function main(): Promise<void> {
  const repoRoot = findHarnessRepoRoot(process.cwd());
  const artifactRoot = resolve(
    process.env.VULTURE_HARNESS_ARTIFACT_ROOT ?? join(repoRoot, ".artifacts"),
  );
  const archiveRoot = resolve(
    process.env.VULTURE_HARNESS_ARCHIVE_ROOT ?? join(artifactRoot, "harness-runs"),
  );
  const reportDir = resolve(
    process.env.VULTURE_HARNESS_REPORT_DIR ?? join(artifactRoot, "harness-report"),
  );
  const limit = parseHarnessTrendLimit(process.env.VULTURE_HARNESS_TREND_LIMIT);
  const snapshots = readHarnessTrendSnapshots(archiveRoot, limit);
  if (snapshots.length === 0) {
    console.log(`Harness trend: no snapshots found at ${archiveRoot}`);
    console.log("Run bun run harness:ci first; trend reads .artifacts/harness-runs/<id>/harness-report/report.json.");
    return;
  }
  const trend = buildHarnessTrend({ snapshots, archiveRoot });
  const { jsonPath, markdownPath } = writeHarnessTrendReport(reportDir, trend);
  console.log(`Harness trend: ${trend.window} snapshots`);
  console.log(`Range: ${trend.earliest} -> ${trend.latest}`);
  console.log(`Flake candidates: ${trend.flakeCandidates.length}`);
  console.log(`Regressions: ${trend.regressions.length}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${markdownPath}`);
}

if (import.meta.main) {
  await main();
}
