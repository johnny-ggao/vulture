import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { buildServer } from "../server";
import {
  defaultAcceptanceScenarios,
  filterAcceptanceScenariosByTags,
  runAcceptanceSuite,
  selectAcceptanceScenarios,
  writeAcceptanceFailureReport,
  writeAcceptanceJUnitReport,
  writeAcceptanceSuiteArtifacts,
} from "./acceptanceSuite";
import { loadAcceptanceScenarioFiles } from "./acceptanceScenarioLoader";
import type { AcceptanceScenario } from "./acceptanceRunner";

const TOKEN = "x".repeat(43);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = findRepoRoot(process.cwd());
  const scenarios = filterScenarios(args.tags, availableScenarios(args.scenarioFiles, repoRoot));
  if (args.list) {
    for (const scenario of scenarios) {
      console.log(`${scenario.id}\t${scenario.name}\t${(scenario.tags ?? []).join(",")}`);
    }
    return;
  }
  const artifactDir = resolve(process.env.VULTURE_ACCEPTANCE_ARTIFACT_DIR ?? join(repoRoot, ".artifacts", "acceptance"));
  const profileDir = resolve(process.env.VULTURE_ACCEPTANCE_PROFILE_DIR ?? join(artifactDir, `.profile-${process.pid}`));
  const workspaceDir = resolve(process.env.VULTURE_ACCEPTANCE_WORKSPACE_DIR ?? join(artifactDir, `.workspace-${process.pid}`));
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  const restoreOpenAIKey = disableRealLlmUnlessOptedIn();
  try {
    const makeApp = () => buildServer({
      port: Number(process.env.VULTURE_ACCEPTANCE_PORT ?? 4099),
      token: process.env.VULTURE_ACCEPTANCE_TOKEN ?? TOKEN,
      shellCallbackUrl: process.env.VULTURE_ACCEPTANCE_SHELL_URL ?? "http://127.0.0.1:1",
      shellPid: process.pid,
      profileDir,
      privateWorkspaceHomeDir: workspaceDir,
    });
    const app = makeApp();

    const results = await runAcceptanceSuite({
      app,
      token: process.env.VULTURE_ACCEPTANCE_TOKEN ?? TOKEN,
      artifactDir,
      scenarios: selectAcceptanceScenarios(args.scenarios, scenarios),
      profileDir,
      restartApp: makeApp,
      pollIntervalMs: Number(process.env.VULTURE_ACCEPTANCE_POLL_MS ?? 25),
      timeoutMs: Number(process.env.VULTURE_ACCEPTANCE_TIMEOUT_MS ?? 5_000),
    });
    const summary = writeAcceptanceSuiteArtifacts(artifactDir, results);
    const junitPath = writeAcceptanceJUnitReport(artifactDir, results);
    const failureReportPath = writeAcceptanceFailureReport(artifactDir, results);
    for (const result of results) {
      const marker = result.status === "passed" ? "PASS" : "FAIL";
      console.log(`${marker} ${result.scenarioId} -> ${result.artifactPath}`);
      const failed = result.steps.find((step) => step.status === "failed");
      if (failed) console.log(`  ${failed.action}: ${failed.error}`);
    }
    console.log(`JUnit report: ${junitPath}`);
    if (failureReportPath) console.log(`Failure report: ${failureReportPath}`);
    console.log(`Acceptance: ${summary.passed}/${summary.total} passed`);
    process.exitCode = summary.status === "passed" ? 0 : 1;
  } finally {
    restoreOpenAIKey();
    if (process.env.VULTURE_ACCEPTANCE_KEEP_PROFILE !== "1") {
      rmSync(profileDir, { recursive: true, force: true });
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }
}

function parseArgs(args: string[]): { list: boolean; scenarios: string[]; scenarioFiles: string[]; tags: string[] } {
  const scenarios = parseScenarioList(process.env.VULTURE_ACCEPTANCE_SCENARIOS ?? "");
  const scenarioFiles = parseScenarioList(process.env.VULTURE_ACCEPTANCE_SCENARIO_FILES ?? "");
  const tags = parseScenarioList(process.env.VULTURE_ACCEPTANCE_TAGS ?? "");
  let list = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--list") {
      list = true;
      continue;
    }
    if (arg === "--scenario") {
      const value = args[index + 1];
      if (!value) throw new Error("--scenario requires an id");
      scenarios.push(value);
      index += 1;
      continue;
    }
    if (arg === "--scenario-file") {
      const value = args[index + 1];
      if (!value) throw new Error("--scenario-file requires a path");
      scenarioFiles.push(value);
      index += 1;
      continue;
    }
    if (arg === "--tag") {
      const value = args[index + 1];
      if (!value) throw new Error("--tag requires a value");
      tags.push(...parseScenarioList(value));
      index += 1;
      continue;
    }
    if (arg.startsWith("--scenario=")) {
      scenarios.push(arg.slice("--scenario=".length));
      continue;
    }
    if (arg.startsWith("--scenario-file=")) {
      scenarioFiles.push(arg.slice("--scenario-file=".length));
      continue;
    }
    if (arg.startsWith("--tag=")) {
      tags.push(...parseScenarioList(arg.slice("--tag=".length)));
      continue;
    }
    throw new Error(`Unknown argument ${arg}`);
  }
  return { list, scenarios, scenarioFiles, tags };
}

function parseScenarioList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function availableScenarios(scenarioFiles: readonly string[], repoRoot: string) {
  return scenarioFiles.length > 0
    ? loadAcceptanceScenarioFiles(scenarioFiles.map((path) => resolveScenarioFilePath(path, repoRoot)))
    : defaultAcceptanceScenarios;
}

function filterScenarios(tags: readonly string[], scenarios: readonly AcceptanceScenario[]): AcceptanceScenario[] {
  const filtered = filterAcceptanceScenariosByTags(tags, scenarios);
  if (tags.length > 0 && filtered.length === 0) {
    const known = [...new Set(scenarios.flatMap((scenario) => scenario.tags ?? []))].sort().join(", ");
    throw new Error(`No acceptance scenarios matched tags ${tags.join(", ")}. Known tags: ${known}`);
  }
  return filtered;
}

function resolveScenarioFilePath(path: string, repoRoot: string): string {
  if (path.startsWith("/")) return path;
  const cwdPath = resolve(path);
  if (existsSync(cwdPath)) return cwdPath;
  return resolve(repoRoot, path);
}

function disableRealLlmUnlessOptedIn(): () => void {
  if (process.env.VULTURE_ACCEPTANCE_REAL_LLM === "1") return () => {};
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  return () => {
    if (previous === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previous;
    }
  };
}

function findRepoRoot(start: string): string {
  let current = resolve(start);
  while (true) {
    const packagePath = join(current, "package.json");
    if (existsSync(packagePath)) {
      try {
        const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { name?: string };
        if (parsed.name === "vulture") return current;
      } catch {
        // Keep walking; malformed package files should not hide a parent root.
      }
    }
    const parent = dirname(current);
    if (parent === current) return resolve(start);
    current = parent;
  }
}

await main();
