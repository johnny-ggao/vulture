import { join, resolve } from "node:path";
import {
  findHarnessRepoRoot,
  formatHarnessListLine,
  parseHarnessCliArgs,
  selectHarnessScenarios,
} from "@vulture/harness-core";

import {
  writeDesktopFailureReport,
  writeDesktopJUnit,
  writeDesktopSuiteSummary,
  type DesktopScenarioResult,
} from "./artifacts";
import { RealDesktopDriver } from "./desktopDriver";
import { runDesktopScenario, type DesktopDriver } from "./runner";
import { desktopScenarios, type DesktopScenario } from "./scenarios";

export interface DesktopE2EArgs {
  list: boolean;
  scenarios: string[];
  tags: string[];
  artifactDir?: string;
}

export interface DesktopE2EIO {
  env?: Record<string, string | undefined>;
  cwd?: string;
  write?: (message: string) => void;
  writeError?: (message: string) => void;
}

export interface DesktopE2EDependencies {
  createDriver?: (options: { repoRoot: string; webdriverUrl: string }) => DesktopDriver;
  runScenario?: typeof runDesktopScenario;
  writeSuiteSummary?: (root: string, results: readonly DesktopScenarioResult[]) => string;
  writeJUnit?: (root: string, results: readonly DesktopScenarioResult[]) => string;
  writeFailureReport?: (root: string, results: readonly DesktopScenarioResult[]) => string | null;
}

export function parseDesktopE2EArgs(
  argv: readonly string[],
  env: Record<string, string | undefined> = process.env,
): DesktopE2EArgs {
  const parsed = parseHarnessCliArgs(argv, env, {
    idEnv: "VULTURE_DESKTOP_E2E_SCENARIOS",
    tagEnv: "VULTURE_DESKTOP_E2E_TAGS",
    artifactDirEnv: "VULTURE_DESKTOP_E2E_ARTIFACT_DIR",
  });
  return {
    list: parsed.list,
    scenarios: parsed.ids,
    tags: parsed.tags,
    ...(parsed.artifactDir ? { artifactDir: parsed.artifactDir } : {}),
  };
}

export function selectDesktopScenarios(
  input: Pick<DesktopE2EArgs, "scenarios" | "tags">,
  scenarios: readonly DesktopScenario[] = desktopScenarios,
): DesktopScenario[] {
  return selectHarnessScenarios(scenarios, {
    ids: input.scenarios,
    tags: input.tags,
  }, {
    label: "desktop E2E scenarios",
    unknownMessage: (id) => `Unknown desktop E2E scenario ${id}`,
    noTagMatchMessage: (tags) => `No desktop E2E scenarios match tags: ${tags.join(", ")}`,
  });
}

export async function main(
  argv = process.argv.slice(2),
  io: DesktopE2EIO = {},
  dependencies: DesktopE2EDependencies = {},
): Promise<number> {
  const write = io.write ?? console.log;
  const writeError = io.writeError ?? console.error;

  try {
    const args = parseDesktopE2EArgs(argv, io.env);
    const selected = selectDesktopScenarios(args);

    if (args.list) {
      for (const scenario of selected) {
        write(formatHarnessListLine(scenario));
      }
      return 0;
    }

    const repoRoot = findHarnessRepoRoot(io.cwd ?? process.cwd());
    const artifactRoot = resolveArtifactRoot(repoRoot, args.artifactDir ?? io.env?.VULTURE_DESKTOP_E2E_ARTIFACT_DIR);
    const webdriverUrl = io.env?.VULTURE_DESKTOP_E2E_WEBDRIVER_URL ?? "http://127.0.0.1:4444";
    const createDriver = dependencies.createDriver ?? ((options) => new RealDesktopDriver(options));
    const runScenario = dependencies.runScenario ?? runDesktopScenario;
    const writeSuiteSummary = dependencies.writeSuiteSummary ?? writeDesktopSuiteSummary;
    const writeJUnit = dependencies.writeJUnit ?? writeDesktopJUnit;
    const writeFailureReport = dependencies.writeFailureReport ?? writeDesktopFailureReport;
    const results: DesktopScenarioResult[] = [];

    for (const scenario of selected) {
      const result = await runScenario({
        artifactRoot,
        driver: createDriver({ repoRoot, webdriverUrl }),
        scenario,
      });
      results.push(result);
      write(`${result.status === "passed" ? "PASS" : "FAIL"} ${scenario.id} (${result.artifactPath})`);
    }

    const summaryPath = writeSuiteSummary(artifactRoot, results);
    const junitPath = writeJUnit(artifactRoot, results);
    const failureReportPath = writeFailureReport(artifactRoot, results);

    write(`Desktop E2E summary: ${summaryPath}`);
    write(`Desktop E2E JUnit: ${junitPath}`);
    if (failureReportPath) {
      writeError(`Desktop E2E failure report: ${failureReportPath}`);
    }

    return results.every((result) => result.status === "passed") ? 0 : 1;
  } catch (error) {
    writeError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main();
}

function resolveArtifactRoot(repoRoot: string, configuredRoot: string | undefined): string {
  return resolve(repoRoot, configuredRoot ?? join(".artifacts", "desktop-e2e"));
}
