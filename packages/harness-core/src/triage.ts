import {
  laneHarnessCommand,
  type HarnessArtifactValidationReport,
  type HarnessLane,
  type HarnessStatus,
} from "./shared";

export interface HarnessTriageCiStep {
  id: string;
  name: string;
  command: readonly string[];
  status: HarnessStatus;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
  error?: string;
}

export type HarnessTriageCategory = "ci-step" | "lane" | "artifact-validation";

export interface HarnessTriageItem {
  category: HarnessTriageCategory;
  id: string;
  title: string;
  detail: string;
  command?: string;
  artifactPath?: string;
  path?: string;
}

export interface HarnessTriageReport {
  schemaVersion: 1;
  generatedAt: string;
  status: HarnessStatus;
  summary: {
    total: number;
    ciSteps: number;
    lanes: number;
    artifactValidation: number;
  };
  items: HarnessTriageItem[];
}

export interface HarnessTriageHarnessReportLane {
  lane: HarnessLane;
  status: HarnessStatus | "missing";
  total: number;
  passed: number;
  failed: number;
  artifactPath?: string;
}

export interface HarnessTriageHarnessReport {
  lanes: readonly HarnessTriageHarnessReportLane[];
  missingRequiredLanes: readonly HarnessLane[];
}

export function buildHarnessTriageReport(options: {
  ciSteps?: readonly HarnessTriageCiStep[];
  harnessReport?: HarnessTriageHarnessReport | null;
  artifactValidationReport?: HarnessArtifactValidationReport | null;
  generatedAt?: string;
}): HarnessTriageReport {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const items: HarnessTriageItem[] = [];

  for (const step of options.ciSteps ?? []) {
    if (step.status !== "failed") continue;
    items.push({
      category: "ci-step",
      id: step.id,
      title: step.name,
      detail: step.error ?? "CI step failed",
      command: step.command.join(" "),
    });
  }

  const harnessReport = options.harnessReport;
  if (harnessReport) {
    for (const lane of harnessReport.lanes) {
      if (lane.status === "failed") {
        items.push({
          category: "lane",
          id: lane.lane,
          title: `${lane.lane} lane failed`,
          detail: `${lane.failed}/${lane.total} scenarios failed`,
          command: laneHarnessCommand(lane.lane),
          ...(lane.artifactPath ? { artifactPath: lane.artifactPath } : {}),
        });
      }
    }
    for (const lane of harnessReport.missingRequiredLanes) {
      items.push({
        category: "lane",
        id: lane,
        title: `${lane} lane missing`,
        detail: "Required lane artifact is missing from the aggregate harness report",
        command: laneHarnessCommand(lane),
      });
    }
  }

  for (const check of options.artifactValidationReport?.checks ?? []) {
    if (check.status !== "failed") continue;
    items.push({
      category: "artifact-validation",
      id: check.id,
      title: `Artifact validation failed: ${check.id}`,
      detail: check.detail,
      ...(check.command ? { command: check.command } : {}),
      ...(check.path ? { path: check.path } : {}),
    });
  }

  const ciSteps = items.filter((item) => item.category === "ci-step").length;
  const lanes = items.filter((item) => item.category === "lane").length;
  const artifactValidation = items.filter((item) => item.category === "artifact-validation").length;
  return {
    schemaVersion: 1,
    generatedAt,
    status: items.length === 0 ? "passed" : "failed",
    summary: {
      total: items.length,
      ciSteps,
      lanes,
      artifactValidation,
    },
    items,
  };
}
