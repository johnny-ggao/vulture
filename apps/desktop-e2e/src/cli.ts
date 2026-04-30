import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

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
  const parsed: DesktopE2EArgs = {
    list: false,
    scenarios: splitList(env.VULTURE_DESKTOP_E2E_SCENARIOS ?? ""),
    tags: splitList(env.VULTURE_DESKTOP_E2E_TAGS ?? ""),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--list") {
      parsed.list = true;
      continue;
    }

    if (arg === "--scenario") {
      const value = argv[index + 1];
      if (!isSeparatedValue(value)) {
        throw new Error("--scenario requires an id");
      }
      parsed.scenarios.push(value.trim());
      index += 1;
      continue;
    }

    if (arg === "--tag") {
      const value = argv[index + 1];
      if (!isSeparatedValue(value)) {
        throw new Error("--tag requires a value");
      }
      parsed.tags.push(...parseTagValue(value));
      index += 1;
      continue;
    }

    if (arg.startsWith("--scenario=")) {
      const value = arg.slice("--scenario=".length).trim();
      if (!value) {
        throw new Error("--scenario requires an id");
      }
      parsed.scenarios.push(value);
      continue;
    }

    if (arg.startsWith("--tag=")) {
      parsed.tags.push(...parseTagValue(arg.slice("--tag=".length)));
      continue;
    }

    throw new Error(`Unknown argument ${arg}`);
  }

  return parsed;
}

export function selectDesktopScenarios(
  input: Pick<DesktopE2EArgs, "scenarios" | "tags">,
  scenarios: readonly DesktopScenario[] = desktopScenarios,
): DesktopScenario[] {
  if (input.scenarios.length > 0) {
    const seen = new Set<string>();
    const selected: DesktopScenario[] = [];

    for (const id of input.scenarios) {
      const scenario = scenarios.find((candidate) => candidate.id === id);
      if (!scenario) {
        throw new Error(`Unknown desktop E2E scenario ${id}`);
      }
      if (!seen.has(id)) {
        seen.add(id);
        selected.push(scenario);
      }
    }

    return selected;
  }

  if (input.tags.length === 0) {
    return [...scenarios];
  }

  const tags = new Set(input.tags);
  const selected = scenarios.filter((scenario) => scenario.tags.some((tag) => tags.has(tag)));
  if (selected.length === 0) {
    throw new Error(`No desktop E2E scenarios match tags: ${input.tags.join(", ")}`);
  }
  return selected;
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
        write(`${scenario.id}\t${scenario.name}\t${scenario.tags.join(",")}`);
      }
      return 0;
    }

    const repoRoot = resolveRepoRoot(io.cwd ?? process.cwd());
    const artifactRoot = resolveArtifactRoot(repoRoot, io.env?.VULTURE_DESKTOP_E2E_ARTIFACT_DIR);
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

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseTagValue(value: string): string[] {
  const tags = splitList(value);
  if (tags.length === 0) {
    throw new Error("--tag requires a value");
  }
  return tags;
}

function isSeparatedValue(value: string | undefined): value is string {
  if (!value) {
    return false;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 && !trimmed.startsWith("--");
}

if (import.meta.main) {
  process.exitCode = await main();
}

function resolveArtifactRoot(repoRoot: string, configuredRoot: string | undefined): string {
  return resolve(repoRoot, configuredRoot ?? join(".artifacts", "desktop-e2e"));
}

function resolveRepoRoot(startDir: string): string {
  const initial = resolve(startDir);
  let current = initial;

  while (true) {
    const packageJsonPath = join(current, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { workspaces?: unknown };
        if (Array.isArray(parsed.workspaces) || parsed.workspaces && typeof parsed.workspaces === "object") {
          return current;
        }
      } catch {
        // Ignore invalid package.json files while walking upward.
      }
    }

    const parent = resolve(current, "..");
    if (parent === current) {
      return initial;
    }
    current = parent;
  }
}
