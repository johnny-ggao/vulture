import {
  parseHarnessCliArgs,
  runHarnessLaneCli,
} from "@vulture/harness-core";
import type { GatewayToolCategory } from "../tools/types";
import {
  defaultToolContractFixtures,
  filterToolContractFixtures,
  runToolContractHarness,
  summarizeToolContractResults,
  type ToolContractFixture,
} from "./toolContractHarness";

export function parseArgs(args: readonly string[]): {
  list: boolean;
  ids: string[];
  tags: string[];
  artifactDir?: string;
} {
  return parseHarnessCliArgs(args, process.env, {
    idFlag: "tool",
    tagFlag: "category",
    idEnv: "VULTURE_TOOL_CONTRACT_TOOLS",
    tagEnv: "VULTURE_TOOL_CONTRACT_CATEGORIES",
  });
}

await runHarnessLaneCli<ToolContractFixture>({
  parseOptions: {
    idFlag: "tool",
    tagFlag: "category",
    idEnv: "VULTURE_TOOL_CONTRACT_TOOLS",
    tagEnv: "VULTURE_TOOL_CONTRACT_CATEGORIES",
  },
  scenarios: defaultToolContractFixtures,
  filter: (fixtures, { ids, tags }) =>
    filterToolContractFixtures(fixtures, {
      tools: [...ids],
      categories: tags as GatewayToolCategory[],
    }),
  formatListLine: (fixture) =>
    `${fixture.toolId}\t${fixture.expectedCategory}\t${fixture.expectedRisk}`,
  artifactDirEnv: "VULTURE_TOOL_CONTRACT_ARTIFACT_DIR",
  artifactDirSubdir: "tool-contract-harness",
  workspaceDirEnv: "VULTURE_TOOL_CONTRACT_WORKSPACE_DIR",
  laneTitle: "Tool contract harness",
  run: async ({ scenarios, artifactDir, workspacePath }) => {
    const results = await runToolContractHarness({
      artifactDir,
      fixtures: [...scenarios],
      workspacePath,
    });
    const summary = summarizeToolContractResults(results);
    return {
      status: summary.status,
      total: summary.total,
      passed: summary.passed,
      rows: results.map((result) => ({
        id: result.toolId,
        status: result.status,
        details: result.checks
          .filter((check) => check.status === "failed")
          .map((check) => `${check.name}: ${check.error}`),
      })),
    };
  },
});
