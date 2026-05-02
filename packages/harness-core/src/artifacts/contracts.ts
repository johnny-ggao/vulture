export type HarnessArtifactContractStability = "stable" | "diagnostic";

export interface HarnessArtifactContract {
  id: string;
  path: string;
  schemaVersion: 1 | 2;
  stability: HarnessArtifactContractStability;
  fields: string[];
  notes: string;
}

export const DEFAULT_HARNESS_BUNDLE_REQUIRED_FILES = [
  "runtime-harness/manifest.json",
  "runtime-harness/junit.xml",
  "tool-contract-harness/manifest.json",
  "tool-contract-harness/junit.xml",
  "acceptance/manifest.json",
  "acceptance/junit.xml",
  "harness-catalog/catalog.json",
  "harness-catalog/doctor.json",
  "harness-report/report.json",
  "harness-report/retention.json",
  "harness-report/history.json",
  "harness-report/bundle-manifest.json",
] as const;

export const HARNESS_ARTIFACT_CONTRACTS: readonly HarnessArtifactContract[] = [
  {
    id: "harness-report",
    path: "harness-report/report.json",
    schemaVersion: 2,
    stability: "stable",
    fields: [
      "schemaVersion",
      "generatedAt",
      "status",
      "lanes",
      "missingRequiredLanes",
      "missingOptionalLanes",
      "doctor",
      "ci",
      "artifactValidation",
      "failures",
    ],
    notes:
      "Single source of truth: lane status, doctor summary, CI step results, artifact validation, and failure triage in one document.",
  },
  {
    id: "retention",
    path: "harness-report/retention.json",
    schemaVersion: 1,
    stability: "stable",
    fields: ["schemaVersion", "generatedAt", "status", "archiveRoot", "policy", "snapshots", "kept", "deleted", "errors"],
    notes: "Snapshot retention decision record.",
  },
  {
    id: "history",
    path: "harness-report/history.json",
    schemaVersion: 1,
    stability: "stable",
    fields: ["schemaVersion", "generatedAt", "archiveRoot", "latestStatus", "total", "entries"],
    notes: "Retained snapshot history index.",
  },
  {
    id: "bundle-manifest",
    path: "harness-report/bundle-manifest.json",
    schemaVersion: 1,
    stability: "stable",
    fields: ["schemaVersion", "generatedAt", "artifactRoot", "fileCount", "totalBytes", "requiredFiles", "files"],
    notes: "Artifact file inventory with required-file status and file hashes.",
  },
] as const;
