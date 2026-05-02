import { join, resolve } from "node:path";
import {
  buildHarnessDoctorReport,
  buildHarnessCatalog,
  findHarnessRepoRoot,
  inspectHarnessCatalogLanes,
  inspectHarnessCatalog,
  writeHarnessCatalog,
  writeHarnessDoctorReport,
  type HarnessDoctorRule,
} from "../packages/harness-core/src/index";
import { harnessCatalogLanes } from "./harnessCatalog";

const REQUIRED_RULES: HarnessDoctorRule[] = [
  { id: "lane-runtime", name: "Runtime lane", lane: "runtime", minScenarios: 1 },
  { id: "lane-tool-contract", name: "Tool contract lane", lane: "tool-contract", minScenarios: 20 },
  { id: "lane-acceptance", name: "Acceptance lane", lane: "acceptance", minScenarios: 8 },
  { id: "lane-desktop-e2e", name: "Desktop E2E lane", lane: "desktop-e2e", minScenarios: 1 },
  { id: "coverage-recovery", name: "Recovery coverage", tag: "recovery", minScenarios: 2 },
  { id: "coverage-tools", name: "Tool coverage", tag: "tools", minScenarios: 2 },
  { id: "coverage-attachments", name: "Attachment coverage", tag: "attachments", minScenarios: 1 },
  { id: "coverage-browser", name: "Browser tool coverage", lane: "tool-contract", tag: "browser", minScenarios: 1 },
  { id: "coverage-web", name: "Web tool coverage", lane: "tool-contract", tag: "web", minScenarios: 1 },
  { id: "coverage-subagents", name: "Subagent coverage", tag: "subagents", minScenarios: 2 },
  { id: "coverage-desktop-smoke", name: "Desktop smoke coverage", lane: "desktop-e2e", tag: "smoke", minScenarios: 1 },
];

const RECOMMENDED_RULES: HarnessDoctorRule[] = [
  { id: "recommended-skills", name: "Skill product coverage", tag: "skills", severity: "warning" },
  { id: "recommended-mcp", name: "MCP product coverage", tag: "mcp", severity: "warning" },
  { id: "recommended-idempotency", name: "Idempotency product coverage", tag: "idempotency", severity: "warning" },
];

async function main(): Promise<void> {
  const repoRoot = findHarnessRepoRoot(process.cwd());
  const artifactDir = resolve(
    process.env.VULTURE_HARNESS_CATALOG_DIR ??
      join(repoRoot, ".artifacts", "harness-catalog"),
  );
  const lanes = harnessCatalogLanes();
  writeHarnessCatalog(artifactDir, lanes);
  const catalog = buildHarnessCatalog(lanes);
  const coverageReport = inspectHarnessCatalog(catalog, [...REQUIRED_RULES, ...RECOMMENDED_RULES]);
  const report = buildHarnessDoctorReport(
    catalog,
    [...inspectHarnessCatalogLanes(lanes), ...coverageReport.checks],
  );
  const { jsonPath, markdownPath } = writeHarnessDoctorReport(artifactDir, report);

  console.log(`Harness doctor: ${report.status}`);
  console.log(`Checks: ${report.checks.filter((check) => check.status === "passed").length}/${report.checks.length} passed`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${markdownPath}`);
  if (report.status === "failed") process.exitCode = 1;
}

export function harnessDoctorRules(): HarnessDoctorRule[] {
  return [...REQUIRED_RULES, ...RECOMMENDED_RULES];
}

if (import.meta.main) {
  await main();
}
