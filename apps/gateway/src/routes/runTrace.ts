import { Hono } from "hono";
import type { ArtifactStore } from "../domain/artifactStore";
import type { MessageStore } from "../domain/messageStore";
import type { RunStore } from "../domain/runStore";
import type { SubagentSessionStore } from "../domain/subagentSessionStore";

export interface RunTraceDeps {
  runs: RunStore;
  messages: MessageStore;
  subagentSessions: SubagentSessionStore;
  artifacts: ArtifactStore;
}

export function runTraceRouter(deps: RunTraceDeps): Hono {
  const app = new Hono();

  app.get("/v1/runs/:rid/trace", (c) => {
    const runId = c.req.param("rid");
    const run = deps.runs.get(runId);
    if (!run) return c.json({ code: "run.not_found", message: runId }, 404);
    const messages = deps.messages
      .listSince({ conversationId: run.conversationId })
      .filter((message) => message.runId === run.id || message.id === run.triggeredByMessageId || message.id === run.resultMessageId);
    return c.json({
      run,
      messages,
      events: deps.runs.listEventsAfter(runId, -1),
      recovery: deps.runs.getRecoveryState(runId),
      subagentSessions: deps.subagentSessions.list({ parentRunId: runId }),
      artifacts: deps.artifacts.list({ runId }),
    });
  });

  return app;
}
