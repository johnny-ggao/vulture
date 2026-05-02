import { join, resolve } from "node:path";
import {
  findHarnessRepoRoot,
  formatHarnessListLine,
  parseHarnessCliArgs,
} from "@vulture/harness-core";
import {
  defaultRuntimeHarnessScenarios,
  filterRuntimeHarnessScenarios,
  runRuntimeHarness,
  summarizeRuntimeHarnessResults,
} from "./runtimeHarness";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scenarios = filterRuntimeHarnessScenarios(defaultRuntimeHarnessScenarios, {
    scenarios: args.ids,
    tags: args.tags,
  });
  if (args.list) {
    for (const scenario of scenarios) {
      console.log(formatHarnessListLine(scenario));
    }
    return;
  }

  const repoRoot = findHarnessRepoRoot(process.cwd());
  const artifactDir = resolve(
    args.artifactDir ??
      process.env.VULTURE_RUNTIME_HARNESS_ARTIFACT_DIR ??
      join(repoRoot, ".artifacts", "runtime-harness"),
  );
  const workspacePath = resolve(
    process.env.VULTURE_RUNTIME_HARNESS_WORKSPACE_DIR ?? repoRoot,
  );
  const results = await runRuntimeHarness({ artifactDir, scenarios, workspacePath });
  const summary = summarizeRuntimeHarnessResults(results);

  for (const result of results) {
    const marker = result.status === "passed" ? "PASS" : "FAIL";
    console.log(`${marker} ${result.scenarioId}`);
    if (result.error) console.log(`  ${result.error}`);
  }
  console.log(`Runtime harness: ${summary.passed}/${summary.total} passed`);
  process.exitCode = summary.status === "passed" ? 0 : 1;
}

export function parseArgs(args: readonly string[]): {
  list: boolean;
  ids: string[];
  tags: string[];
  artifactDir?: string;
} {
  return parseHarnessCliArgs(args, process.env, {
    idEnv: "VULTURE_RUNTIME_HARNESS_SCENARIOS",
    tagEnv: "VULTURE_RUNTIME_HARNESS_TAGS",
  });
}

await main();
