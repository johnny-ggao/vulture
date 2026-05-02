import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareHarnessSnapshotsNewestFirst,
  type HarnessArtifactRetentionReport,
  type HarnessArtifactSnapshot,
} from "./retention";
import type { HarnessStatus } from "../shared";

export interface HarnessArtifactHistoryEntry extends HarnessArtifactSnapshot {
  retentionReasons: string[];
  reportMarkdownPath?: string;
}

export interface HarnessArtifactHistory {
  schemaVersion: 1;
  generatedAt: string;
  archiveRoot: string;
  latestStatus: HarnessStatus | "none";
  total: number;
  entries: HarnessArtifactHistoryEntry[];
}

export function buildHarnessArtifactHistory(
  retentionReport: HarnessArtifactRetentionReport,
  generatedAt = new Date().toISOString(),
): HarnessArtifactHistory {
  const entries = retentionReport.kept
    .map((entry): HarnessArtifactHistoryEntry => {
      const harnessReportDir = entry.artifactDirs.includes("harness-report")
        ? join(entry.path, "harness-report")
        : null;
      return {
        id: entry.id,
        path: entry.path,
        generatedAt: entry.generatedAt,
        status: entry.status,
        artifactDirs: [...entry.artifactDirs],
        retentionReasons: [...entry.reasons],
        ...(harnessReportDir ? {
          reportMarkdownPath: join(harnessReportDir, "report.md"),
        } : {}),
      };
    })
    .sort(compareHarnessSnapshotsNewestFirst);

  return {
    schemaVersion: 1,
    generatedAt,
    archiveRoot: retentionReport.archiveRoot,
    latestStatus: entries[0]?.status ?? "none",
    total: entries.length,
    entries,
  };
}

export function writeHarnessArtifactHistoryReport(
  artifactDir: string,
  history: HarnessArtifactHistory,
): { jsonPath: string; markdownPath: string } {
  mkdirSync(artifactDir, { recursive: true });
  const jsonPath = join(artifactDir, "history.json");
  const markdownPath = join(artifactDir, "history.md");
  writeFileSync(jsonPath, `${JSON.stringify(history, null, 2)}\n`);
  writeFileSync(markdownPath, renderHarnessArtifactHistoryMarkdown(history));
  return { jsonPath, markdownPath };
}

function renderHarnessArtifactHistoryMarkdown(history: HarnessArtifactHistory): string {
  const lines = [
    "# Harness Artifact History",
    "",
    `Generated: ${history.generatedAt}`,
    `Archive root: ${history.archiveRoot}`,
    `Latest status: ${history.latestStatus}`,
    `Snapshots: ${history.total}`,
    "",
    "## Snapshots",
    "",
  ];
  if (history.entries.length === 0) {
    lines.push("- None");
    return `${lines.join("\n")}\n`;
  }

  for (const entry of history.entries) {
    lines.push(
      `### ${entry.id}`,
      "",
      `- Status: ${entry.status}`,
      `- Generated: ${entry.generatedAt}`,
      `- Path: ${entry.path}`,
      `- Retention: ${entry.retentionReasons.join(", ") || "unknown"}`,
      `- Artifacts: ${entry.artifactDirs.join(", ") || "none"}`,
    );
    if (entry.reportMarkdownPath) lines.push(`- Report: ${entry.reportMarkdownPath}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
