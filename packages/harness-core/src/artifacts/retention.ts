import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_HARNESS_ARTIFACT_DIRS,
  readJsonIfPresent,
  type HarnessStatus,
} from "../shared";

export interface HarnessArtifactRetentionPolicy {
  keepLast: number;
  keepLatestPassed: boolean;
  keepLatestFailed: boolean;
  artifactDirNames: readonly string[];
}

export interface HarnessArtifactSnapshotManifest {
  schemaVersion: 1;
  id: string;
  generatedAt: string;
  status: HarnessStatus;
  sourceRoot: string;
  artifactDirs: string[];
}

export interface HarnessArtifactSnapshot {
  id: string;
  path: string;
  generatedAt: string;
  status: HarnessStatus;
  artifactDirs: string[];
}

export interface HarnessArtifactRetentionEntry extends HarnessArtifactSnapshot {
  kept: boolean;
  reasons: string[];
}

export interface HarnessArtifactRetentionReport {
  schemaVersion: 1;
  generatedAt: string;
  status: HarnessStatus;
  archiveRoot: string;
  policy: {
    keepLast: number;
    keepLatestPassed: boolean;
    keepLatestFailed: boolean;
  };
  snapshots: HarnessArtifactRetentionEntry[];
  kept: HarnessArtifactRetentionEntry[];
  deleted: HarnessArtifactRetentionEntry[];
  errors: Array<{ id: string; path: string; error: string }>;
}

export function archiveHarnessArtifacts(options: {
  artifactRoot: string;
  status: HarnessStatus;
  generatedAt?: string;
  archiveRoot?: string;
  runId?: string;
  artifactDirNames?: readonly string[];
}): HarnessArtifactSnapshot {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const artifactRoot = resolve(options.artifactRoot);
  const archiveRoot = resolve(options.archiveRoot ?? join(artifactRoot, "harness-runs"));
  const id = sanitizeHarnessRunId(options.runId ?? `${generatedAt}-${options.status}`);
  const snapshotPath = join(archiveRoot, id);
  const artifactDirNames = options.artifactDirNames ?? DEFAULT_HARNESS_ARTIFACT_DIRS;
  const copied: string[] = [];

  rmSync(snapshotPath, { recursive: true, force: true });
  mkdirSync(snapshotPath, { recursive: true });
  for (const dirName of artifactDirNames) {
    const source = join(artifactRoot, dirName);
    if (!existsSync(source) || !statSync(source).isDirectory()) continue;
    cpSync(source, join(snapshotPath, dirName), { recursive: true });
    copied.push(dirName);
  }

  const manifest: HarnessArtifactSnapshotManifest = {
    schemaVersion: 1,
    id,
    generatedAt,
    status: options.status,
    sourceRoot: artifactRoot,
    artifactDirs: copied,
  };
  writeFileSync(join(snapshotPath, "retention-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    id,
    path: snapshotPath,
    generatedAt,
    status: options.status,
    artifactDirs: copied,
  };
}

export function pruneHarnessArtifactSnapshots(options: {
  archiveRoot: string;
  policy?: Partial<HarnessArtifactRetentionPolicy>;
  generatedAt?: string;
}): HarnessArtifactRetentionReport {
  const archiveRoot = resolve(options.archiveRoot);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const policy = normalizeHarnessRetentionPolicy(options.policy);
  const snapshots = readHarnessArtifactSnapshots(archiveRoot);
  const reasons = retentionReasons(snapshots, policy);
  const errors: HarnessArtifactRetentionReport["errors"] = [];
  const entries: HarnessArtifactRetentionEntry[] = [];

  for (const snapshot of snapshots) {
    const snapshotReasons = reasons.get(snapshot.id) ?? [];
    const entry: HarnessArtifactRetentionEntry = {
      ...snapshot,
      kept: snapshotReasons.length > 0,
      reasons: snapshotReasons,
    };
    if (!entry.kept) {
      try {
        rmSync(snapshot.path, { recursive: true, force: true });
      } catch (error) {
        entry.kept = true;
        entry.reasons = ["delete-failed"];
        errors.push({
          id: snapshot.id,
          path: snapshot.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    entries.push(entry);
  }

  const kept = entries.filter((entry) => entry.kept);
  const deleted = entries.filter((entry) => !entry.kept);
  return {
    schemaVersion: 1,
    generatedAt,
    status: errors.length === 0 ? "passed" : "failed",
    archiveRoot,
    policy: {
      keepLast: policy.keepLast,
      keepLatestPassed: policy.keepLatestPassed,
      keepLatestFailed: policy.keepLatestFailed,
    },
    snapshots: entries,
    kept,
    deleted,
    errors,
  };
}

export function retainHarnessArtifacts(options: {
  artifactRoot: string;
  status: HarnessStatus;
  generatedAt?: string;
  archiveRoot?: string;
  runId?: string;
  policy?: Partial<HarnessArtifactRetentionPolicy>;
}): HarnessArtifactRetentionReport {
  const artifactRoot = resolve(options.artifactRoot);
  const archiveRoot = resolve(options.archiveRoot ?? join(artifactRoot, "harness-runs"));
  const policy = normalizeHarnessRetentionPolicy(options.policy);
  archiveHarnessArtifacts({
    artifactRoot,
    archiveRoot,
    status: options.status,
    generatedAt: options.generatedAt,
    runId: options.runId,
    artifactDirNames: policy.artifactDirNames,
  });
  return pruneHarnessArtifactSnapshots({
    archiveRoot,
    generatedAt: options.generatedAt,
    policy,
  });
}

export function writeHarnessArtifactRetentionReport(
  artifactDir: string,
  report: HarnessArtifactRetentionReport,
): { jsonPath: string; markdownPath: string } {
  mkdirSync(artifactDir, { recursive: true });
  const jsonPath = join(artifactDir, "retention.json");
  const markdownPath = join(artifactDir, "retention.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderHarnessArtifactRetentionMarkdown(report));
  return { jsonPath, markdownPath };
}

export function compareHarnessSnapshotsNewestFirst(
  left: HarnessArtifactSnapshot,
  right: HarnessArtifactSnapshot,
): number {
  const generatedAtOrder = right.generatedAt.localeCompare(left.generatedAt, "en");
  return generatedAtOrder !== 0 ? generatedAtOrder : right.id.localeCompare(left.id, "en");
}

function normalizeHarnessRetentionPolicy(
  policy: Partial<HarnessArtifactRetentionPolicy> = {},
): HarnessArtifactRetentionPolicy {
  const keepLast = Math.max(0, Math.floor(policy.keepLast ?? 5));
  return {
    keepLast,
    keepLatestPassed: policy.keepLatestPassed ?? true,
    keepLatestFailed: policy.keepLatestFailed ?? true,
    artifactDirNames: policy.artifactDirNames ?? DEFAULT_HARNESS_ARTIFACT_DIRS,
  };
}

function readHarnessArtifactSnapshots(archiveRoot: string): HarnessArtifactSnapshot[] {
  if (!existsSync(archiveRoot)) return [];
  return readdirSync(archiveRoot)
    .map((entry) => {
      const snapshotPath = join(archiveRoot, entry);
      if (!statSync(snapshotPath).isDirectory()) return null;
      const manifest = readJsonIfPresent<HarnessArtifactSnapshotManifest>(
        join(snapshotPath, "retention-manifest.json"),
      );
      if (!manifest || manifest.schemaVersion !== 1) return null;
      if (manifest.status !== "passed" && manifest.status !== "failed") return null;
      if (!Array.isArray(manifest.artifactDirs)) return null;
      return {
        id: manifest.id,
        path: snapshotPath,
        generatedAt: manifest.generatedAt,
        status: manifest.status,
        artifactDirs: manifest.artifactDirs,
      } satisfies HarnessArtifactSnapshot;
    })
    .filter((snapshot): snapshot is HarnessArtifactSnapshot => snapshot !== null)
    .sort(compareHarnessSnapshotsNewestFirst);
}

function retentionReasons(
  snapshots: readonly HarnessArtifactSnapshot[],
  policy: HarnessArtifactRetentionPolicy,
): Map<string, string[]> {
  const reasons = new Map<string, string[]>();
  const keep = (snapshot: HarnessArtifactSnapshot | undefined, reason: string) => {
    if (!snapshot) return;
    const existing = reasons.get(snapshot.id) ?? [];
    if (!existing.includes(reason)) existing.push(reason);
    reasons.set(snapshot.id, existing);
  };

  for (const snapshot of snapshots.slice(0, policy.keepLast)) {
    keep(snapshot, "recent");
  }
  if (policy.keepLatestPassed) {
    keep(snapshots.find((snapshot) => snapshot.status === "passed"), "latest-passed");
  }
  if (policy.keepLatestFailed) {
    keep(snapshots.find((snapshot) => snapshot.status === "failed"), "latest-failed");
  }
  return reasons;
}

function sanitizeHarnessRunId(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "harness-run";
}

function renderHarnessArtifactRetentionMarkdown(report: HarnessArtifactRetentionReport): string {
  const lines = [
    "# Harness Artifact Retention",
    "",
    `Generated: ${report.generatedAt}`,
    `Status: ${report.status}`,
    `Archive root: ${report.archiveRoot}`,
    "",
    "## Policy",
    "",
    `- Keep last: ${report.policy.keepLast}`,
    `- Keep latest passed: ${report.policy.keepLatestPassed}`,
    `- Keep latest failed: ${report.policy.keepLatestFailed}`,
    "",
    "## Kept",
    "",
  ];
  if (report.kept.length === 0) {
    lines.push("- None");
  } else {
    for (const entry of report.kept) {
      lines.push(`- KEPT ${entry.id}: ${entry.reasons.join(", ")}`);
    }
  }
  lines.push("", "## Deleted", "");
  if (report.deleted.length === 0) {
    lines.push("- None");
  } else {
    for (const entry of report.deleted) {
      lines.push(`- DELETED ${entry.id}`);
    }
  }
  if (report.errors.length > 0) {
    lines.push("", "## Errors", "");
    for (const error of report.errors) {
      lines.push(`- ${error.id}: ${error.error} (${error.path})`);
    }
  }
  return `${lines.join("\n")}\n`;
}
