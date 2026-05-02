import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { findHarnessRepoRoot } from "../packages/harness-core/src/index";

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
  "runtime-harness",
  "tool-contract-harness",
  "acceptance",
  "harness-catalog",
  "harness-report",
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
  if (summary.status === "failed") process.exitCode = 1;
}

export function cleanHarnessCiArtifacts(artifactRoot: string): void {
  for (const dirName of CI_ARTIFACT_DIRS) {
    rmSync(join(artifactRoot, dirName), { recursive: true, force: true });
  }
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
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  await main();
}
