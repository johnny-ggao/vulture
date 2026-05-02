import { join, resolve } from "node:path";
import {
  findHarnessRepoRoot,
  writeHarnessCatalog,
  type HarnessCatalogLane,
} from "../packages/harness-core/src/index";
import { desktopScenarios } from "../apps/desktop-e2e/src/scenarios";
import { defaultAcceptanceScenarios } from "../apps/gateway/src/harness/acceptanceSuite";
import { defaultRuntimeHarnessScenarios } from "../apps/gateway/src/harness/runtimeHarness";
import { defaultToolContractFixtures } from "../apps/gateway/src/harness/toolContractHarness";

async function main(): Promise<void> {
  const repoRoot = findHarnessRepoRoot(process.cwd());
  const artifactDir = resolve(
    process.env.VULTURE_HARNESS_CATALOG_DIR ??
      join(repoRoot, ".artifacts", "harness-catalog"),
  );
  const { jsonPath, markdownPath, catalog } = writeHarnessCatalog(artifactDir, harnessCatalogLanes());
  console.log(`Harness catalog: ${catalog.scenarios.length} scenarios across ${catalog.lanes.length} lanes`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${markdownPath}`);
}

export function harnessCatalogLanes(): HarnessCatalogLane[] {
  return [
    {
      lane: "runtime",
      description: "In-process agent runtime scenarios with scripted LLM/tool behavior.",
      scenarios: defaultRuntimeHarnessScenarios,
    },
    {
      lane: "tool-contract",
      description: "Core tool metadata, schema, approval, idempotency, and SDK adapter contracts.",
      scenarios: defaultToolContractFixtures,
    },
    {
      lane: "acceptance",
      description: "Gateway product scenarios over HTTP, SSE, recovery, attachments, MCP, and subagents.",
      scenarios: defaultAcceptanceScenarios,
    },
    {
      lane: "desktop-e2e",
      description: "Real Tauri shell smoke scenarios driven through WebDriver.",
      scenarios: desktopScenarios,
    },
  ];
}

if (import.meta.main) {
  await main();
}
