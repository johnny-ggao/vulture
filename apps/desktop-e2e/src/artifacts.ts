import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
  const failed = results.filter((result) => result.status === "failed");
  if (failed.length === 0) {
    return null;
  }

  mkdirSync(root, { recursive: true });

  const lines = ["# Desktop E2E Failure Report", "", `Failed: ${failed.length}/${results.length}`, ""];
  for (const result of failed) {
    const failedSteps = result.steps.filter((step) => step.status === "failed");
    const primaryFailure = failedSteps[0];
    const additionalFailures = failedSteps.slice(1);
    lines.push(`## ${result.id}`, "", `Name: ${result.name}`, `Artifacts: ${result.artifactPath}`);

    if (primaryFailure) {
      lines.push(`Failed step: ${primaryFailure.name}`, "Error:", fencedMarkdown(primaryFailure.error ?? "unknown failure"));
    }

    if (additionalFailures.length > 0) {
      lines.push("", "Additional failures:");
      for (const step of additionalFailures) {
        lines.push(step.name, "Error:", fencedMarkdown(step.error ?? "unknown failure"));
      }
    }

    lines.push("");
  }

  const path = join(root, "failure-report.md");
  writeFileSync(path, `${lines.join("\n")}\n`);

  return path;
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}

function fencedMarkdown(value: string): string {
  const longestFence = Math.max(3, ...Array.from(value.matchAll(/`+/g), (match) => match[0].length));
  const fence = "`".repeat(longestFence + 1);
  return `${fence}\n${value}\n${fence}`;
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

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
