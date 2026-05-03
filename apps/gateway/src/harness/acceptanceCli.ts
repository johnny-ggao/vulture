import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  findHarnessRepoRoot,
  formatHarnessListLine,
  parseHarnessCliArgs,
  splitList,
} from "@vulture/harness-core";
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
import { makeScriptedLlm } from "../runtime/scriptedLlm";
import { makeScriptedModelProvider } from "../runtime/scriptedModelProvider";

const TOKEN = "x".repeat(43);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = findHarnessRepoRoot(process.cwd());
  const scenarios = filterScenarios(args.tags, availableScenarios(args.scenarioFiles, repoRoot));
  if (args.list) {
    for (const scenario of scenarios) {
      console.log(formatHarnessListLine(scenario));
    }
    return;
  }
  const artifactDir = resolve(args.artifactDir ?? process.env.VULTURE_ACCEPTANCE_ARTIFACT_DIR ?? join(repoRoot, ".artifacts", "acceptance"));
  const profileDir = resolve(process.env.VULTURE_ACCEPTANCE_PROFILE_DIR ?? join(artifactDir, `.profile-${process.pid}`));
  const workspaceDir = resolve(process.env.VULTURE_ACCEPTANCE_WORKSPACE_DIR ?? join(artifactDir, `.workspace-${process.pid}`));
  mkdirSync(artifactDir, { recursive: true });
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });

  const restoreOpenAIKey = disableRealLlmUnlessOptedIn();
  const scriptedLlm = makeScriptedLlm();
  const scriptedModel = makeScriptedModelProvider();
  try {
    const makeApp = () => buildServer({
      port: Number(process.env.VULTURE_ACCEPTANCE_PORT ?? 4099),
      token: process.env.VULTURE_ACCEPTANCE_TOKEN ?? TOKEN,
      shellCallbackUrl: process.env.VULTURE_ACCEPTANCE_SHELL_URL ?? "http://127.0.0.1:1",
      shellPid: process.pid,
      profileDir,
      privateWorkspaceHomeDir: workspaceDir,
      // Wire both scripted controllers and let buildServer route per call:
      // when scriptedLlm has an active step, the legacy LlmCallable path
      // runs (existing scripted-llm-* scenarios). Otherwise the SDK
      // Runner driven by scriptedModel runs — this is the path that
      // exercises the real approval gate.
      llmOverride: scriptedLlm.llm,
      llmOverrideHasScript: () => scriptedLlm.current() !== null,
      scriptedModelProvider: scriptedModel.provider,
      registerHarnessTestTools: true,
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
      scriptedLlm,
      scriptedModel,
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

function parseArgs(args: string[]): { list: boolean; scenarios: string[]; scenarioFiles: string[]; tags: string[]; artifactDir?: string } {
  const scenarioFiles = splitList(process.env.VULTURE_ACCEPTANCE_SCENARIO_FILES ?? "");
  const passthrough: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--scenario-file") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--scenario-file requires a path");
      scenarioFiles.push(value);
      index += 1;
      continue;
    }
    if (arg.startsWith("--scenario-file=")) {
      const value = arg.slice("--scenario-file=".length).trim();
      if (!value) throw new Error("--scenario-file requires a path");
      scenarioFiles.push(value);
      continue;
    }
    passthrough.push(arg);
  }
  const parsed = parseHarnessCliArgs(passthrough, process.env, {
    idEnv: "VULTURE_ACCEPTANCE_SCENARIOS",
    tagEnv: "VULTURE_ACCEPTANCE_TAGS",
    artifactDirEnv: "VULTURE_ACCEPTANCE_ARTIFACT_DIR",
  });
  return {
    list: parsed.list,
    scenarios: parsed.ids,
    scenarioFiles,
    tags: parsed.tags,
    artifactDir: parsed.artifactDir,
  };
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

await main();
