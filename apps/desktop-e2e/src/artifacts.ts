import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  writeHarnessFailureReport,
  writeHarnessManifest,
  type HarnessResultReport,
} from "@vulture/harness-core";

export interface DesktopStepResult {
  name: string;
  status: "passed" | "failed";
  error?: string;
}

export interface DesktopScenarioResult {
  id: string;
  name: string;
  status: "passed" | "failed";
  durationMs: number;
  artifactPath: string;
  steps: DesktopStepResult[];
}

export interface DesktopArtifactRun {
  scenarioDir: string;
  screenshotsDir: string;
  logsDir: string;
}

export function createDesktopArtifactRun(
  root: string,
  scenarioId: string,
  runId = new Date().toISOString(),
): DesktopArtifactRun {
  const scenarioDir = join(root, `${safePathPart(scenarioId)}-${safePathPart(runId)}`);
  const screenshotsDir = join(scenarioDir, "screenshots");
  const logsDir = join(scenarioDir, "logs");

  mkdirSync(screenshotsDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });

  return { scenarioDir, screenshotsDir, logsDir };
}

export function writeDesktopSuiteSummary(root: string, results: readonly DesktopScenarioResult[]): string {
  mkdirSync(root, { recursive: true });

  const passed = results.filter((result) => result.status === "passed").length;
  const failed = results.length - passed;
  const path = join(root, "summary.json");
  writeFileSync(path, `${JSON.stringify({ total: results.length, passed, failed, results }, null, 2)}\n`);
  writeHarnessManifest(root, "desktop-e2e", results.map(desktopReportResult));

  return path;
}

export function writeDesktopScenarioSummary(root: string, result: DesktopScenarioResult): string {
  mkdirSync(root, { recursive: true });

  const path = join(root, "summary.json");
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);

  return path;
}

export const writeDesktopSummary = writeDesktopSuiteSummary;

export function writeDesktopJUnit(root: string, results: readonly DesktopScenarioResult[]): string {
  mkdirSync(root, { recursive: true });

  const failures = results.filter((result) => result.status === "failed").length;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="vulture.desktop-e2e" tests="${results.length}" failures="${failures}">`,
  ];

  for (const result of results) {
    lines.push(
      `  <testcase classname="vulture.desktop-e2e" name="${xml(result.name)}" time="${(result.durationMs / 1000).toFixed(3)}">`,
    );

    const failedSteps = result.steps.filter((step) => step.status === "failed");
    const primaryFailure = failedSteps[0];
    if (primaryFailure) {
      const message = `${primaryFailure.name}: ${primaryFailure.error ?? "unknown failure"}`;
      lines.push(`    <failure message="${xml(message)}">${xml(formatFailureBody(failedSteps))}</failure>`);
    }

    lines.push(`    <system-out>${xml(result.artifactPath)}</system-out>`);
    lines.push("  </testcase>");
  }

  lines.push("</testsuite>");

  const path = join(root, "junit.xml");
  writeFileSync(path, `${lines.join("\n")}\n`);

  return path;
}

export function writeDesktopFailureReport(
  root: string,
  results: readonly DesktopScenarioResult[],
): string | null {
  return writeHarnessFailureReport(root, {
    title: "Desktop E2E Failure Report",
    results: results.map(desktopReportResult),
  });
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

function formatFailureBody(failedSteps: readonly DesktopStepResult[]): string {
  const [primaryFailure, ...additionalFailures] = failedSteps;
  if (!primaryFailure) {
    return "";
  }

  const lines = [`${primaryFailure.name}: ${primaryFailure.error ?? "unknown failure"}`];
  if (additionalFailures.length > 0) {
    lines.push("Additional failures:");
    for (const step of additionalFailures) {
      lines.push(`- ${step.name}: ${step.error ?? "unknown failure"}`);
    }
  }

  return lines.join("\n");
}

function desktopReportResult(result: DesktopScenarioResult): HarnessResultReport {
  return {
    id: result.id,
    name: result.name,
    status: result.status,
    durationMs: result.durationMs,
    artifactPath: result.artifactPath,
    steps: result.steps.map((step) => ({
      name: step.name,
      status: step.status,
      error: step.error,
    })),
  };
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
