import { Hono } from "hono";
import type { ArtifactStore } from "../domain/artifactStore";
import type { RunDiagnosticsFilter, RunStore } from "../domain/runStore";
import type { SubagentSessionStore } from "../domain/subagentSessionStore";
import type { RunStatus } from "@vulture/protocol/src/v1/run";

export interface RunLogsDeps {
  runs: RunStore;
  subagentSessions: SubagentSessionStore;
  artifacts: ArtifactStore;
}

const RUN_STATUSES = new Set<RunStatus | "active">([
  "queued",
  "running",
  "recoverable",
  "succeeded",
  "failed",
  "cancelled",
  "active",
]);

export function runLogsRouter(deps: RunLogsDeps): Hono {
  const app = new Hono();

  app.get("/v1/run-logs", (c) => {
    const query = c.req.query();
    const status = parseStatus(query.status);
    if (query.status && !status) {
      return c.json({ code: "run_logs.invalid_status", message: "status is invalid" }, 400);
    }

    const limit = parsePositiveInt(query.limit, 50, 100);
    const offset = parsePositiveInt(query.offset, 0, Number.MAX_SAFE_INTEGER);
    const filter: RunDiagnosticsFilter = {
      limit,
      offset,
      status: status ?? undefined,
      agentId: query.agentId?.trim() || undefined,
    };
    const summaries = deps.runs.listDiagnostics(filter);
    const artifactCountByRunId = countArtifactsByRunId(deps.artifacts.list());
    return c.json({
      items: summaries.map((summary) => ({
        ...summary,
        artifactCount: artifactCountByRunId.get(summary.run.id) ?? 0,
        subagentCount: deps.subagentSessions.count({ parentRunId: summary.run.id }),
      })),
      nextOffset: summaries.length === limit ? offset + limit : null,
    });
  });

  return app;
}

function parseStatus(value: string | undefined): RunStatus | "active" | null {
  if (!value) return null;
  return RUN_STATUSES.has(value as RunStatus | "active") ? (value as RunStatus | "active") : null;
}

function countArtifactsByRunId(
  artifacts: ReadonlyArray<{ runId: string }>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const artifact of artifacts) {
    counts.set(artifact.runId, (counts.get(artifact.runId) ?? 0) + 1);
  }
  return counts;
}

function parsePositiveInt(
  value: string | undefined,
  fallback: number,
  max: number,
): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}
