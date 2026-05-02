import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_HARNESS_ARTIFACT_DIRS,
  buildHarnessArtifactHistory,
  buildHarnessTriageReport,
  findHarnessRepoRoot,
  retainHarnessArtifacts,
  validateHarnessArtifactBundle,
  writeHarnessArtifactHistoryReport,
  writeHarnessArtifactRetentionReport,
  writeHarnessArtifactValidationReport,
  writeHarnessTriageReport,
  type HarnessReport,
} from "../packages/harness-core/src/index";

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

export interface HarnessCiSummary {
  schemaVersion: 1;
  generatedAt: string;
  status: "passed" | "failed";
  total: number;
  passed: number;
  failed: number;
  steps: HarnessCiStepResult[];
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
      "scripts/harnessCi.test.ts",
      "scripts/harnessArtifacts.test.ts",
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
  {
    id: "harness-report",
    name: "Harness report",
    command: ["bun", "run", "harness:report"],
  },
  {
    id: "harness-artifacts",
    name: "Harness artifact validation",
    command: ["bun", "run", "harness:artifacts"],
  },
];

async function main(): Promise<void> {
  const repoRoot = findHarnessRepoRoot(process.cwd());
  const artifactRoot = resolve(
    process.env.VULTURE_HARNESS_ARTIFACT_ROOT ??
      join(repoRoot, ".artifacts"),
  );
  cleanHarnessCiArtifacts(artifactRoot);

  const results = runHarnessCiSteps(HARNESS_CI_STEPS, repoRoot);
  const summary = buildHarnessCiSummary(results);
  const paths = writeHarnessCiSummary(join(artifactRoot, "harness-report"), summary);
  console.log(`Harness CI: ${summary.status}`);
  console.log(`Steps: ${summary.passed}/${summary.total} passed`);
  console.log(`CI summary JSON: ${paths.jsonPath}`);
  console.log(`CI summary Markdown: ${paths.markdownPath}`);

  const finalArtifactReport = validateHarnessArtifactBundle(artifactRoot);
  const finalArtifactPaths = writeHarnessArtifactValidationReport(
    join(artifactRoot, "harness-report"),
    finalArtifactReport,
  );
  console.log(`Final artifact validation: ${finalArtifactReport.status}`);
  console.log(`Final artifact validation JSON: ${finalArtifactPaths.jsonPath}`);
  console.log(`Final artifact validation Markdown: ${finalArtifactPaths.markdownPath}`);

  const finalStatus = summary.status === "failed" || finalArtifactReport.status === "failed"
    ? "failed"
    : "passed";
  const triage = buildHarnessTriageReport({
    ciSteps: summary.steps,
    harnessReport: readHarnessReport(join(artifactRoot, "harness-report", "report.json")),
    artifactValidationReport: finalArtifactReport,
    generatedAt: summary.generatedAt,
  });
  const triagePaths = writeHarnessTriageReport(join(artifactRoot, "harness-report"), triage);
  console.log(`Failure triage: ${triage.status}`);
  console.log(`Failure triage items: ${triage.summary.total}`);
  console.log(`Failure triage JSON: ${triagePaths.jsonPath}`);
  console.log(`Failure triage Markdown: ${triagePaths.markdownPath}`);

  const retentionReport = retainHarnessArtifacts({
    artifactRoot,
    status: finalStatus,
    generatedAt: summary.generatedAt,
    policy: {
      keepLast: harnessRetentionKeepLast(process.env),
      artifactDirNames: CI_ARTIFACT_DIRS,
    },
  });
  const retentionPaths = writeHarnessArtifactRetentionReport(
    join(artifactRoot, "harness-report"),
    retentionReport,
  );
  console.log(`Artifact retention: ${retentionReport.status}`);
  console.log(`Artifact snapshots kept/deleted: ${retentionReport.kept.length}/${retentionReport.deleted.length}`);
  console.log(`Artifact retention JSON: ${retentionPaths.jsonPath}`);
  console.log(`Artifact retention Markdown: ${retentionPaths.markdownPath}`);

  const history = buildHarnessArtifactHistory(retentionReport, summary.generatedAt);
  const historyPaths = writeHarnessArtifactHistoryReport(
    join(artifactRoot, "harness-report"),
    history,
  );
  console.log(`Artifact history snapshots: ${history.total}`);
  console.log(`Artifact history JSON: ${historyPaths.jsonPath}`);
  console.log(`Artifact history Markdown: ${historyPaths.markdownPath}`);
  if (finalStatus === "failed" || retentionReport.status === "failed") process.exitCode = 1;
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

function readHarnessReport(path: string): HarnessReport | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as HarnessReport;
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

export function buildHarnessCiSummary(
  steps: readonly HarnessCiStepResult[],
  generatedAt = new Date().toISOString(),
): HarnessCiSummary {
  const passed = steps.filter((step) => step.status === "passed").length;
  const failed = steps.length - passed;
  return {
    schemaVersion: 1,
    generatedAt,
    status: failed === 0 ? "passed" : "failed",
    total: steps.length,
    passed,
    failed,
    steps: [...steps],
  };
}

export function writeHarnessCiSummary(
  artifactDir: string,
  summary: HarnessCiSummary,
): { jsonPath: string; markdownPath: string } {
  mkdirSync(artifactDir, { recursive: true });
  const jsonPath = join(artifactDir, "ci-summary.json");
  const markdownPath = join(artifactDir, "ci-summary.md");
  writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(markdownPath, renderHarnessCiSummaryMarkdown(summary));
  return { jsonPath, markdownPath };
}

function renderHarnessCiSummaryMarkdown(summary: HarnessCiSummary): string {
  const lines = [
    "# Harness CI Summary",
    "",
    `Generated: ${summary.generatedAt}`,
    `Status: ${summary.status}`,
    `Steps: ${summary.passed}/${summary.total} passed`,
    "",
    "## Steps",
    "",
  ];
  for (const step of summary.steps) {
    const suffix = step.error ? ` - ${step.error}` : "";
    lines.push(
      `- ${step.status.toUpperCase()} ${step.id}: ${step.command.join(" ")} (${step.durationMs}ms)${suffix}`,
    );
  }
  const failedSteps = summary.steps.filter((step) => step.status === "failed");
  if (failedSteps.length > 0) {
    lines.push("", "## Failed Steps", "");
    for (const step of failedSteps) {
      lines.push(`### ${step.id}`, "", "```bash", step.command.join(" "), "```");
      if (step.error) lines.push("", `Error: ${step.error}`);
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  await main();
}
