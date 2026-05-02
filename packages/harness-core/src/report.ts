import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HarnessDoctorReport } from "./doctor";
import {
  fencedMarkdown,
  uniquePreserveOrder,
  type HarnessArtifactManifest,
  type HarnessArtifactValidationCheck,
  type HarnessArtifactValidationReport,
  type HarnessLane,
  type HarnessStatus,
} from "./shared";
import {
  buildHarnessTriageReport,
  type HarnessTriageCiStep,
  type HarnessTriageHarnessReport,
  type HarnessTriageItem,
} from "./triage";

export interface HarnessReportLane {
  lane: HarnessLane;
  status: HarnessStatus | "missing";
  total: number;
  passed: number;
  failed: number;
  artifactPath?: string;
  generatedAt?: string;
}

export interface HarnessReportCiStep {
  id: string;
  name: string;
  command: string[];
  status: HarnessStatus;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  error?: string;
}

export interface HarnessReportCi {
  status: HarnessStatus;
  total: number;
  passed: number;
  failed: number;
  steps: HarnessReportCiStep[];
}

export interface HarnessReportArtifactValidation {
  status: HarnessStatus;
  total: number;
  passed: number;
  failed: number;
  checks: HarnessArtifactValidationCheck[];
}

export interface HarnessReportFailures {
  summary: {
    total: number;
    ciSteps: number;
    lanes: number;
    artifactValidation: number;
  };
  items: HarnessTriageItem[];
}

export interface HarnessReport {
  schemaVersion: 2;
  generatedAt: string;
  status: "passed" | "warning" | "failed";
  lanes: HarnessReportLane[];
  missingRequiredLanes: HarnessLane[];
  missingOptionalLanes: HarnessLane[];
  doctor: {
    status: HarnessDoctorReport["status"];
    checks: number;
    passed: number;
    warnings: number;
    failed: number;
  } | null;
  ci: HarnessReportCi | null;
  artifactValidation: HarnessReportArtifactValidation | null;
  failures: HarnessReportFailures;
}

export interface BuildHarnessReportOptions {
  manifests: readonly HarnessArtifactManifest[];
  requiredLanes: readonly HarnessLane[];
  optionalLanes?: readonly HarnessLane[];
  doctor?: HarnessDoctorReport | null;
  ci?: readonly HarnessTriageCiStep[] | null;
  artifactValidation?: HarnessArtifactValidationReport | null;
  generatedAt?: string;
}

export function buildHarnessReport(options: BuildHarnessReportOptions): HarnessReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const manifestsByLane = new Map(options.manifests.map((manifest) => [manifest.lane, manifest]));
  const laneOrder = uniquePreserveOrder([
    ...options.requiredLanes,
    ...(options.optionalLanes ?? []),
    ...options.manifests.map((manifest) => manifest.lane),
  ]);
  const missingRequiredLanes = options.requiredLanes.filter((lane) => !manifestsByLane.has(lane));
  const missingOptionalLanes = (options.optionalLanes ?? []).filter((lane) => !manifestsByLane.has(lane));
  const lanes = laneOrder.map((lane): HarnessReportLane => {
    const manifest = manifestsByLane.get(lane);
    if (!manifest) {
      return {
        lane,
        status: "missing",
        total: 0,
        passed: 0,
        failed: 0,
      };
    }
    return {
      lane,
      status: manifest.status,
      total: manifest.total,
      passed: manifest.passed,
      failed: manifest.failed,
      artifactPath: manifest.results.find((result) => result.artifactPath)?.artifactPath,
      generatedAt: manifest.generatedAt,
    };
  });

  const doctor = options.doctor
    ? {
        status: options.doctor.status,
        checks: options.doctor.checks.length,
        passed: options.doctor.checks.filter((check) => check.status === "passed").length,
        warnings: options.doctor.checks.filter((check) => check.status === "warning").length,
        failed: options.doctor.checks.filter((check) => check.status === "failed").length,
      }
    : null;

  const ci = options.ci
    ? buildReportCi(options.ci)
    : null;

  const artifactValidation = options.artifactValidation
    ? buildReportArtifactValidation(options.artifactValidation)
    : null;

  const triageInput: HarnessTriageHarnessReport = {
    lanes,
    missingRequiredLanes,
  };
  const triage = buildHarnessTriageReport({
    ciSteps: options.ci ?? [],
    harnessReport: triageInput,
    artifactValidationReport: options.artifactValidation ?? null,
    generatedAt,
  });
  const failures: HarnessReportFailures = {
    summary: triage.summary,
    items: triage.items,
  };

  const hasFailedLane = lanes.some((lane) => lane.status === "failed");
  const hasMissingRequiredLane = missingRequiredLanes.length > 0;
  const ciFailed = ci?.status === "failed";
  const validationFailed = artifactValidation?.status === "failed";
  const doctorFailed = doctor?.status === "failed";
  const doctorWarning = doctor?.status === "warning";
  const status: HarnessReport["status"] =
    hasMissingRequiredLane || hasFailedLane || ciFailed || validationFailed || doctorFailed
      ? "failed"
      : doctorWarning
        ? "warning"
        : "passed";

  return {
    schemaVersion: 2,
    generatedAt,
    status,
    lanes,
    missingRequiredLanes,
    missingOptionalLanes,
    doctor,
    ci,
    artifactValidation,
    failures,
  };
}

export function writeHarnessReport(
  artifactDir: string,
  options: BuildHarnessReportOptions,
): { jsonPath: string; markdownPath: string; report: HarnessReport } {
  mkdirSync(artifactDir, { recursive: true });
  const report = buildHarnessReport(options);
  const jsonPath = join(artifactDir, "report.json");
  const markdownPath = join(artifactDir, "report.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderHarnessReportMarkdown(report));
  return { jsonPath, markdownPath, report };
}

function buildReportCi(steps: readonly HarnessTriageCiStep[]): HarnessReportCi {
  const stepRows: HarnessReportCiStep[] = steps.map((step) => ({
    id: step.id,
    name: step.name,
    command: [...step.command],
    status: step.status,
    exitCode: typeof step.exitCode === "number" ? step.exitCode : step.exitCode === null ? null : null,
    signal: typeof step.signal === "string" ? step.signal : null,
    durationMs: typeof step.durationMs === "number" ? step.durationMs : 0,
    ...(step.error ? { error: step.error } : {}),
  }));
  const passed = stepRows.filter((step) => step.status === "passed").length;
  const failed = stepRows.length - passed;
  return {
    status: failed === 0 ? "passed" : "failed",
    total: stepRows.length,
    passed,
    failed,
    steps: stepRows,
  };
}

function buildReportArtifactValidation(
  validation: HarnessArtifactValidationReport,
): HarnessReportArtifactValidation {
  const passed = validation.checks.filter((check) => check.status === "passed").length;
  const failed = validation.checks.length - passed;
  return {
    status: validation.status,
    total: validation.checks.length,
    passed,
    failed,
    checks: [...validation.checks],
  };
}

function renderHarnessReportMarkdown(report: HarnessReport): string {
  const lines = [
    "# Harness Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status}`,
    "",
    "## Lanes",
    "",
  ];
  for (const lane of report.lanes) {
    if (lane.status === "missing") {
      lines.push(`- MISSING ${lane.lane}`);
      continue;
    }
    lines.push(`- ${lane.status.toUpperCase()} ${lane.lane}: ${lane.passed}/${lane.total} passed`);
  }
  if (report.missingRequiredLanes.length > 0) {
    lines.push("", "## Missing Required Lanes", "");
    for (const lane of report.missingRequiredLanes) lines.push(`- ${lane}`);
  }
  if (report.missingOptionalLanes.length > 0) {
    lines.push("", "## Missing Optional Lanes", "");
    for (const lane of report.missingOptionalLanes) lines.push(`- ${lane}`);
  }
  if (report.doctor) {
    lines.push(
      "",
      "## Doctor",
      "",
      `- Status: ${report.doctor.status}`,
      `- Checks: ${report.doctor.passed}/${report.doctor.checks} passed`,
      `- Warnings: ${report.doctor.warnings}`,
      `- Failed: ${report.doctor.failed}`,
    );
  }
  if (report.ci) {
    lines.push(
      "",
      "## CI Steps",
      "",
      `- Status: ${report.ci.status}`,
      `- Steps: ${report.ci.passed}/${report.ci.total} passed`,
      "",
    );
    for (const step of report.ci.steps) {
      const suffix = step.error ? ` - ${step.error}` : "";
      lines.push(
        `- ${step.status.toUpperCase()} ${step.id}: ${step.command.join(" ")} (${step.durationMs}ms)${suffix}`,
      );
    }
  }
  if (report.artifactValidation) {
    lines.push(
      "",
      "## Artifact Validation",
      "",
      `- Status: ${report.artifactValidation.status}`,
      `- Checks: ${report.artifactValidation.passed}/${report.artifactValidation.total} passed`,
    );
    const failedChecks = report.artifactValidation.checks.filter((check) => check.status === "failed");
    if (failedChecks.length > 0) {
      lines.push("");
      for (const check of failedChecks) {
        lines.push(`- FAILED ${check.id}: ${check.detail}`);
      }
    }
  }

  lines.push(
    "",
    "## Failures",
    "",
    `Total: ${report.failures.summary.total}`,
  );
  if (report.failures.summary.total === 0) {
    lines.push("", "No failures.");
  } else {
    lines.push(
      `- CI steps: ${report.failures.summary.ciSteps}`,
      `- Lanes: ${report.failures.summary.lanes}`,
      `- Artifact validation: ${report.failures.summary.artifactValidation}`,
      "",
    );
    for (const item of report.failures.items) {
      lines.push(`### ${item.category}: ${item.id}`, "", item.title, "", item.detail);
      if (item.path) lines.push("", `Path: ${item.path}`);
      if (item.artifactPath) lines.push("", `Artifacts: ${item.artifactPath}`);
      if (item.command) lines.push("", "Command:", fencedMarkdown(item.command));
      lines.push("");
    }
  }
  return `${lines.join("\n")}\n`;
}
