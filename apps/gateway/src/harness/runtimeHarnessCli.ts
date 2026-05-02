import {
  formatHarnessListLine,
  parseHarnessCliArgs,
  runHarnessLaneCli,
} from "@vulture/harness-core";
import {
  defaultRuntimeHarnessScenarios,
  filterRuntimeHarnessScenarios,
  runRuntimeHarness,
  summarizeRuntimeHarnessResults,
} from "./runtimeHarness";

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

await runHarnessLaneCli({
  parseOptions: {
    idEnv: "VULTURE_RUNTIME_HARNESS_SCENARIOS",
    tagEnv: "VULTURE_RUNTIME_HARNESS_TAGS",
  },
  scenarios: defaultRuntimeHarnessScenarios,
  filter: (scenarios, { ids, tags }) =>
    filterRuntimeHarnessScenarios(scenarios, { scenarios: [...ids], tags: [...tags] }),
  formatListLine: formatHarnessListLine,
  artifactDirEnv: "VULTURE_RUNTIME_HARNESS_ARTIFACT_DIR",
  artifactDirSubdir: "runtime-harness",
  workspaceDirEnv: "VULTURE_RUNTIME_HARNESS_WORKSPACE_DIR",
  laneTitle: "Runtime harness",
  run: async ({ scenarios, artifactDir, workspacePath }) => {
    const results = await runRuntimeHarness({
      artifactDir,
      scenarios: [...scenarios],
      workspacePath,
    });
    const summary = summarizeRuntimeHarnessResults(results);
    return {
      status: summary.status,
      total: summary.total,
      passed: summary.passed,
      rows: results.map((result) => ({
        id: result.scenarioId,
        status: result.status,
        details: result.error ? [result.error] : [],
      })),
    };
  },
});
