import { join, resolve } from "node:path";
import {
  findHarnessRepoRoot,
  parseHarnessCliArgs,
} from "@vulture/harness-core";
import type { GatewayToolCategory } from "../tools/types";
import {
  defaultToolContractFixtures,
  filterToolContractFixtures,
  runToolContractHarness,
  summarizeToolContractResults,
} from "./toolContractHarness";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const fixtures = filterToolContractFixtures(defaultToolContractFixtures, {
    tools: args.ids,
    categories: args.tags as GatewayToolCategory[],
  });
  if (args.list) {
    for (const fixture of fixtures) {
      console.log(`${fixture.toolId}\t${fixture.expectedCategory}\t${fixture.expectedRisk}`);
    }
    return;
  }

  const repoRoot = findHarnessRepoRoot(process.cwd());
  const artifactDir = resolve(
    args.artifactDir ??
      process.env.VULTURE_TOOL_CONTRACT_ARTIFACT_DIR ??
      join(repoRoot, ".artifacts", "tool-contract-harness"),
  );
  const workspacePath = resolve(
    process.env.VULTURE_TOOL_CONTRACT_WORKSPACE_DIR ?? repoRoot,
  );
  const results = await runToolContractHarness({ artifactDir, fixtures, workspacePath });
  const summary = summarizeToolContractResults(results);

  for (const result of results) {
    const marker = result.status === "passed" ? "PASS" : "FAIL";
    console.log(`${marker} ${result.toolId}`);
    for (const check of result.checks.filter((item) => item.status === "failed")) {
      console.log(`  ${check.name}: ${check.error}`);
    }
  }
  console.log(`Tool contract harness: ${summary.passed}/${summary.total} passed`);
  process.exitCode = summary.status === "passed" ? 0 : 1;
}

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

await main();
