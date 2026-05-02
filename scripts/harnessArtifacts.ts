import { join, resolve } from "node:path";
import {
  findHarnessRepoRoot,
  validateHarnessArtifactBundle,
  writeHarnessArtifactValidationReport,
} from "../packages/harness-core/src/index";

async function main(): Promise<void> {
  const repoRoot = findHarnessRepoRoot(process.cwd());
  const artifactRoot = resolve(
    process.env.VULTURE_HARNESS_ARTIFACT_ROOT ??
      join(repoRoot, ".artifacts"),
  );
  const reportDir = resolve(
    process.env.VULTURE_HARNESS_REPORT_DIR ??
      join(artifactRoot, "harness-report"),
  );
  const report = validateHarnessArtifactBundle(artifactRoot);
  const { jsonPath, markdownPath } = writeHarnessArtifactValidationReport(reportDir, report);

  console.log(`Harness artifact validation: ${report.status}`);
  console.log(`Checks: ${report.checks.filter((check) => check.status === "passed").length}/${report.checks.length} passed`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${markdownPath}`);
  if (report.status === "failed") process.exitCode = 1;
}

if (import.meta.main) {
  await main();
}
