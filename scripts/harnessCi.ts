import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_HARNESS_ARTIFACT_DIRS,
  buildHarnessArtifactHistory,
  buildHarnessBundleManifest,
  findHarnessRepoRoot,
  retainHarnessArtifacts,
  validateHarnessArtifactBundle,
  writeHarnessArtifactHistoryReport,
  writeHarnessBundleManifestReport,
  writeHarnessArtifactRetentionReport,
  writeHarnessReport,
  type HarnessArtifactHistory,
  type HarnessBundleManifest,
  type HarnessReport,
} from "@vulture/harness-core";
import { collectHarnessReportInput } from "./harnessReport";
import {
  buildHarnessTrend,
  parseHarnessTrendLimit,
  readHarnessTrendSnapshots,
  writeHarnessTrendReport,
} from "./harnessTrend";

export interface HarnessCiStep {
  id: string;
  name: string;
  command: readonly string[];
}

export interface HarnessCiStepResult {
  id: string;
  name: string;
  command: string[];
  status: "passed" | "failed";
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  error?: string;
}

export interface HarnessGithubStepSummaryInput {
  artifactRoot: string;
  report: HarnessReport;
  bundleManifest: HarnessBundleManifest;
  history: HarnessArtifactHistory;
}

export type HarnessCiStepRunner = (step: HarnessCiStep, cwd: string) => HarnessCiStepResult;

const CI_ARTIFACT_DIRS = [
  ...DEFAULT_HARNESS_ARTIFACT_DIRS,
];

export const HARNESS_CI_STEPS: HarnessCiStep[] = [
  {
    id: "unit-tests",
    name: "Unit and harness tests",
    command: [
      "bun",
      "test",
      "packages/harness-core/src",
      "scripts/harnessCatalog.test.ts",
      "scripts/harnessDoctor.test.ts",
      "scripts/harnessReport.test.ts",
      "scripts/harnessTrend.test.ts",
      "scripts/harnessCi.test.ts",
      "apps/gateway/src/harness",
    ],
  },
  {
    id: "harness-core-typecheck",
    name: "Harness core typecheck",
    command: ["bun", "--filter", "@vulture/harness-core", "typecheck"],
  },
  {
    id: "gateway-typecheck",
    name: "Gateway typecheck",
    command: ["bun", "--filter", "@vulture/gateway", "typecheck"],
  },
  {
    id: "desktop-ui-typecheck",
    name: "Desktop UI typecheck",
    command: ["bun", "--filter", "@vulture/desktop-ui", "typecheck"],
  },
  {
    id: "runtime-harness",
    name: "Runtime harness",
    command: ["bun", "run", "harness:runtime"],
  },
  {
    id: "tool-contract-harness",
    name: "Tool contract harness",
    command: ["bun", "run", "harness:tools"],
  },
  {
    id: "acceptance-harness",
    name: "Acceptance harness",
    command: ["bun", "run", "harness:acceptance"],
  },
  {
    id: "harness-catalog",
    name: "Harness catalog",
    command: ["bun", "run", "harness:catalog"],
  },
  {
    id: "harness-doctor",
    name: "Harness doctor",
    command: ["bun", "run", "harness:doctor"],
  },
  {
    id: "ui-smoke",
    name: "Desktop UI smoke harness",
    command: ["bun", "run", "harness:ui-smoke"],
  },
];

async function main(): Promise<void> {
  const repoRoot = findHarnessRepoRoot(process.cwd());
  const artifactRoot = resolve(
    process.env.VULTURE_HARNESS_ARTIFACT_ROOT ??
      join(repoRoot, ".artifacts"),
  );
  cleanHarnessCiArtifacts(artifactRoot);

  const stepResults = runHarnessCiSteps(HARNESS_CI_STEPS, repoRoot);
  const generatedAt = new Date().toISOString();
  const reportInput = collectHarnessReportInput(artifactRoot);
  const artifactValidation = validateHarnessArtifactBundle(artifactRoot, generatedAt, {
    requireReport: false,
  });

  const reportDir = join(artifactRoot, "harness-report");
  const { jsonPath, markdownPath, report } = writeHarnessReport(reportDir, {
    generatedAt,
    manifests: reportInput.manifests,
    requiredLanes: reportInput.requiredLanes,
    optionalLanes: reportInput.optionalLanes,
    doctor: reportInput.doctor,
    ci: stepResults.map((step) => ({
      id: step.id,
      name: step.name,
      command: step.command,
      status: step.status,
      exitCode: step.exitCode,
      signal: step.signal,
      durationMs: step.durationMs,
      ...(step.error ? { error: step.error } : {}),
    })),
    artifactValidation,
  });
  console.log(`Harness report: ${report.status}`);
  console.log(`Steps: ${report.ci?.passed ?? 0}/${report.ci?.total ?? 0} passed`);
  console.log(`Failures: ${report.failures.summary.total}`);
  console.log(`Report JSON: ${jsonPath}`);
  console.log(`Report Markdown: ${markdownPath}`);

  const bundleManifest = buildHarnessBundleManifest({
    artifactRoot,
    generatedAt,
    artifactDirNames: CI_ARTIFACT_DIRS,
  });
  const bundlePaths = writeHarnessBundleManifestReport(reportDir, bundleManifest);
  console.log(`Bundle files: ${bundleManifest.fileCount}`);
  console.log(`Bundle JSON: ${bundlePaths.jsonPath}`);

  const retentionReport = retainHarnessArtifacts({
    artifactRoot,
    status: report.status === "failed" ? "failed" : "passed",
    generatedAt,
    policy: {
      keepLast: harnessRetentionKeepLast(process.env),
      artifactDirNames: CI_ARTIFACT_DIRS,
    },
  });
  const retentionPaths = writeHarnessArtifactRetentionReport(reportDir, retentionReport);
  console.log(`Artifact retention: ${retentionReport.status}`);
  console.log(`Snapshots kept/deleted: ${retentionReport.kept.length}/${retentionReport.deleted.length}`);
  console.log(`Retention JSON: ${retentionPaths.jsonPath}`);

  const history = buildHarnessArtifactHistory(retentionReport, generatedAt);
  const historyPaths = writeHarnessArtifactHistoryReport(reportDir, history);
  console.log(`History snapshots: ${history.total}`);
  console.log(`History JSON: ${historyPaths.jsonPath}`);

  const archiveRoot = join(artifactRoot, "harness-runs");
  const trendSnapshots = readHarnessTrendSnapshots(
    archiveRoot,
    parseHarnessTrendLimit(process.env.VULTURE_HARNESS_TREND_LIMIT),
  );
  if (trendSnapshots.length > 0) {
    const trend = buildHarnessTrend({ snapshots: trendSnapshots, archiveRoot, generatedAt });
    const trendPaths = writeHarnessTrendReport(reportDir, trend);
    console.log(
      `Trend window: ${trend.window} snapshots, flake candidates: ${trend.flakeCandidates.length}, regressions: ${trend.regressions.length}`,
    );
    if (trend.regressions.length > 0) {
      for (const regression of trend.regressions) {
        console.log(`  REGRESSION ${regression.stepId}: ${regression.detail}`);
      }
    }
    console.log(`Trend JSON: ${trendPaths.jsonPath}`);
  }

  const githubSummaryPath = writeHarnessGithubStepSummaryIfConfigured(process.env, {
    artifactRoot,
    report,
    bundleManifest,
    history,
  });
  if (githubSummaryPath) console.log(`GitHub step summary: ${githubSummaryPath}`);

  if (report.status === "failed" || retentionReport.status === "failed") {
    process.exitCode = 1;
  }
}

export function cleanHarnessCiArtifacts(artifactRoot: string): void {
  for (const dirName of CI_ARTIFACT_DIRS) {
    rmSync(join(artifactRoot, dirName), { recursive: true, force: true });
  }
}

export function harnessRetentionKeepLast(env: Record<string, string | undefined>): number {
  const raw = env.VULTURE_HARNESS_RETENTION_KEEP_LAST?.trim();
  if (!raw) return 5;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 5;
  return Math.floor(parsed);
}

export function writeHarnessGithubStepSummaryIfConfigured(
  env: Record<string, string | undefined>,
  input: HarnessGithubStepSummaryInput,
): string | null {
  const path = env.GITHUB_STEP_SUMMARY?.trim();
  if (!path) return null;
  writeHarnessGithubStepSummary(path, input);
  return path;
}

export function writeHarnessGithubStepSummary(
  path: string,
  input: HarnessGithubStepSummaryInput,
): void {
  mkdirSync(join(path, ".."), { recursive: true });
  appendFileSync(path, renderHarnessGithubStepSummary(input));
}

export function renderHarnessGithubStepSummary(input: HarnessGithubStepSummaryInput): string {
  const { report } = input;
  const ci = report.ci ?? { status: "passed" as const, total: 0, passed: 0, failed: 0, steps: [] };
  const validation = report.artifactValidation ?? { status: "passed" as const, total: 0, passed: 0, failed: 0, checks: [] };
  const missingRequired = input.bundleManifest.requiredFiles.filter((file) => file.status === "missing");
  const latestSnapshot = input.history.entries[0];
  const lines = [
    "# Vulture Harness CI",
    "",
    `Status: ${report.status}`,
    `Steps: ${ci.passed}/${ci.total} passed`,
    `Failures: ${report.failures.summary.total}`,
    `Artifact validation: ${validation.status}`,
    `Bundle files: ${input.bundleManifest.fileCount}`,
    `Missing required files: ${missingRequired.length}`,
    latestSnapshot ? `Latest snapshot: ${latestSnapshot.id} (${latestSnapshot.status})` : "Latest snapshot: none",
    "",
    "## Steps",
    "",
    "| Step | Status | Command |",
    "| --- | --- | --- |",
  ];
  for (const step of ci.steps) {
    lines.push(`| ${step.id} | ${step.status} | \`${markdownTableCell(step.command.join(" "))}\` |`);
  }

  lines.push("", "## Failures", "");
  if (report.failures.items.length === 0) {
    lines.push("No failures.");
  } else {
    for (const item of report.failures.items) {
      lines.push(`### ${item.category}: ${item.id}`, "", item.detail);
      if (item.path) lines.push("", `Path: ${item.path}`);
      if (item.artifactPath) lines.push("", `Artifacts: ${item.artifactPath}`);
      if (item.command) lines.push("", "```bash", item.command, "```");
      lines.push("");
    }
  }

  lines.push(
    "",
    "## Key Artifacts",
    "",
    `- Report: ${join(input.artifactRoot, "harness-report", "report.md")}`,
    `- Bundle manifest: ${join(input.artifactRoot, "harness-report", "bundle-manifest.md")}`,
    `- History: ${join(input.artifactRoot, "harness-report", "history.md")}`,
    "",
  );
  return `${lines.join("\n")}\n`;
}

function markdownTableCell(value: string): string {
  return value.replaceAll("|", "\\|");
}

export function runHarnessCiSteps(
  steps: readonly HarnessCiStep[],
  cwd: string,
  runner: HarnessCiStepRunner = runHarnessCiStep,
): HarnessCiStepResult[] {
  const results: HarnessCiStepResult[] = [];
  for (const step of steps) {
    results.push(runner(step, cwd));
  }
  return results;
}

export function runHarnessCiStep(step: HarnessCiStep, cwd: string): HarnessCiStepResult {
  const startedAt = Date.now();
  console.log("");
  console.log(`=== ${step.name} ===`);
  console.log(`$ ${step.command.join(" ")}`);
  const [command, ...args] = step.command;
  if (!command) {
    const error = "Harness CI step has no command";
    console.error(error);
    return {
      id: step.id,
      name: step.name,
      command: [],
      status: "failed",
      exitCode: null,
      signal: null,
      durationMs: Date.now() - startedAt,
      error,
    };
  }
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  const exitCode = result.status;
  const status = exitCode === 0 ? "passed" : "failed";
  const error = result.error?.message;
  if (error) console.error(error);
  console.log(`--- ${step.name}: ${status} ---`);
  return {
    id: step.id,
    name: step.name,
    command: [...step.command],
    status,
    exitCode,
    signal: result.signal,
    durationMs: Date.now() - startedAt,
    ...(error ? { error } : {}),
  };
}

if (import.meta.main) {
  await main();
}
