import {
  parseHarnessCliArgs,
  runHarnessLaneCli,
} from "@vulture/harness-core";
import {
  defaultLiveHarnessScenarios,
  filterLiveHarnessScenarios,
  runLiveHarness,
  summarizeLiveHarnessResults,
  type LiveHarnessScenario,
} from "./liveHarness";

const apiKey = process.env.OPENAI_API_KEY?.trim();

if (!apiKey) {
  console.log("Live harness skipped: OPENAI_API_KEY is not set.");
  console.log("Set OPENAI_API_KEY in the environment to opt into the live LLM lane.");
  process.exit(0);
}

export function parseArgs(args: readonly string[]): {
  list: boolean;
  ids: string[];
  tags: string[];
  artifactDir?: string;
} {
  return parseHarnessCliArgs(args, process.env, {
    idEnv: "VULTURE_LIVE_HARNESS_SCENARIOS",
    tagEnv: "VULTURE_LIVE_HARNESS_TAGS",
  });
}

await runHarnessLaneCli<LiveHarnessScenario>({
  parseOptions: {
    idEnv: "VULTURE_LIVE_HARNESS_SCENARIOS",
    tagEnv: "VULTURE_LIVE_HARNESS_TAGS",
  },
  scenarios: defaultLiveHarnessScenarios,
  filter: (scenarios, { ids, tags }) =>
    filterLiveHarnessScenarios(scenarios, { scenarios: [...ids], tags: [...tags] }),
  formatListLine: (scenario) =>
    `${scenario.id}\t${scenario.name}\t${(scenario.tags ?? []).join(",")}`,
  artifactDirEnv: "VULTURE_LIVE_HARNESS_ARTIFACT_DIR",
  artifactDirSubdir: "live-harness",
  workspaceDirEnv: "VULTURE_LIVE_HARNESS_WORKSPACE_DIR",
  laneTitle: "Live LLM harness",
  run: async ({ scenarios, artifactDir, workspacePath }) => {
    const results = await runLiveHarness({
      artifactDir,
      apiKey,
      scenarios: [...scenarios],
      workspacePath,
    });
    const summary = summarizeLiveHarnessResults(results);
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
