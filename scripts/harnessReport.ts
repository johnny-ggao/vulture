import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  findHarnessRepoRoot,
  writeHarnessReport,
  type HarnessArtifactManifest,
  type HarnessDoctorReport,
  type HarnessLane,
} from "../packages/harness-core/src/index";

const REPORT_LANES: Array<{
  lane: HarnessLane;
  artifactDirName: string;
  required: boolean;
}> = [
  { lane: "runtime", artifactDirName: "runtime-harness", required: true },
  { lane: "tool-contract", artifactDirName: "tool-contract-harness", required: true },
  { lane: "acceptance", artifactDirName: "acceptance", required: true },
  { lane: "desktop-e2e", artifactDirName: "desktop-e2e", required: false },
];

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
  const input = collectHarnessReportInput(artifactRoot);
  const { jsonPath, markdownPath, report } = writeHarnessReport(reportDir, input);

  console.log(`Harness report: ${report.status}`);
  console.log(`Lanes: ${report.lanes.filter((lane) => lane.status !== "missing").length}/${report.lanes.length} present`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`Markdown: ${markdownPath}`);
  if (report.status === "failed") process.exitCode = 1;
}

export function collectHarnessReportInput(artifactRoot: string): {
  manifests: HarnessArtifactManifest[];
  requiredLanes: HarnessLane[];
  optionalLanes: HarnessLane[];
  doctor: HarnessDoctorReport | null;
} {
  const manifests = REPORT_LANES
    .map((lane) => readManifest(join(artifactRoot, lane.artifactDirName, "manifest.json")))
    .filter((manifest): manifest is HarnessArtifactManifest => manifest !== null);
  return {
    manifests,
    requiredLanes: REPORT_LANES.filter((lane) => lane.required).map((lane) => lane.lane),
    optionalLanes: REPORT_LANES.filter((lane) => !lane.required).map((lane) => lane.lane),
    doctor: readDoctor(join(artifactRoot, "harness-catalog", "doctor.json")),
  };
}

function readManifest(path: string): HarnessArtifactManifest | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as HarnessArtifactManifest;
  return parsed;
}

function readDoctor(path: string): HarnessDoctorReport | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as HarnessDoctorReport;
  return parsed;
}

if (import.meta.main) {
  await main();
}
