import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fencedMarkdown,
  type HarnessArtifactManifest,
  type HarnessLane,
  type HarnessResultReport,
  type HarnessSuiteSummary,
} from "./shared";

export function buildHarnessSummary(
  lane: HarnessLane,
  results: readonly HarnessResultReport[],
): HarnessSuiteSummary {
  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.length - passed;
  return {
    lane,
    status: failed === 0 ? "passed" : "failed",
    total: results.length,
    passed,
    failed,
    results: [...results],
  };
}

export function writeHarnessManifest(
  artifactDir: string,
  lane: HarnessLane,
  results: readonly HarnessResultReport[],
): string {
  mkdirSync(artifactDir, { recursive: true });
  const manifest: HarnessArtifactManifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    ...buildHarnessSummary(lane, results),
  };
  const path = join(artifactDir, "manifest.json");
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  return path;
}

export function writeHarnessJUnitReport(
  artifactDir: string,
  lane: HarnessLane,
  results: readonly HarnessResultReport[],
): string {
  mkdirSync(artifactDir, { recursive: true });
  const failures = results.filter((result) => result.status === "failed").length;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="${xml(`vulture.${lane}`)}" tests="${results.length}" failures="${failures}">`,
  ];
  for (const result of results) {
    const duration = result.durationMs === undefined ? "" : ` time="${(result.durationMs / 1000).toFixed(3)}"`;
    lines.push(`  <testcase classname="${xml(`vulture.${lane}`)}" name="${xml(result.name)}"${duration}>`);
    const failedStep = result.steps?.find((step) => step.status === "failed");
    const message = failedStep
      ? `${failedStep.name}: ${failedStep.error ?? "unknown failure"}`
      : result.error;
    if (message) {
      lines.push(`    <failure message="${xml(message)}">${xml(message)}</failure>`);
    }
    if (result.artifactPath) lines.push(`    <system-out>${xml(result.artifactPath)}</system-out>`);
    lines.push("  </testcase>");
  }
  lines.push("</testsuite>");
  const path = join(artifactDir, "junit.xml");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

export function writeHarnessFailureReport(
  artifactDir: string,
  options: {
    title: string;
    results: readonly HarnessResultReport[];
  },
): string | null {
  const path = join(artifactDir, "failure-report.md");
  const failed = options.results.filter((result) => result.status === "failed");
  if (failed.length === 0) {
    rmSync(path, { force: true });
    return null;
  }

  mkdirSync(artifactDir, { recursive: true });
  const lines = [`# ${options.title}`, "", `Failed: ${failed.length}/${options.results.length}`, ""];
  for (const result of failed) {
    const failedSteps = result.steps?.filter((step) => step.status === "failed") ?? [];
    const primary = failedSteps[0];
    lines.push(`## ${result.id}`, "", `Name: ${result.name}`);
    if (result.artifactPath) lines.push(`Artifacts: ${result.artifactPath}`);
    if (primary) {
      lines.push(`Failed step: ${primary.name}`, "Error:", fencedMarkdown(primary.error ?? "unknown failure"));
    } else if (result.error) {
      lines.push("Error:", fencedMarkdown(result.error));
    }
    const additional = failedSteps.slice(1);
    if (additional.length > 0) {
      lines.push("", "Additional failures:");
      for (const step of additional) {
        lines.push(step.name, "Error:", fencedMarkdown(step.error ?? "unknown failure"));
      }
    }
    lines.push("");
  }
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
