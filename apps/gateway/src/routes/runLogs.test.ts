import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { ArtifactStore } from "../domain/artifactStore";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { RunStore } from "../domain/runStore";
import { SubagentSessionStore } from "../domain/subagentSessionStore";
import { applyMigrations } from "../persistence/migrate";
import { openDatabase } from "../persistence/sqlite";
import { runLogsRouter } from "./runLogs";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-run-logs-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const conversations = new ConversationStore(db);
  const messages = new MessageStore(db);
  const runs = new RunStore(db);
  const subagentSessions = new SubagentSessionStore(db, { runs, messages });
  const artifacts = new ArtifactStore(join(dir, "artifacts", "index.json"));
  const app = new Hono();
  app.route("/", runLogsRouter({ runs, subagentSessions, artifacts }));
  return {
    app,
    conversations,
    messages,
    runs,
    subagentSessions,
    artifacts,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("runLogsRouter", () => {
  test("lists lightweight run summaries without loading trace details", async () => {
    const fx = fresh();
    const conversation = fx.conversations.create({ agentId: "local-work-agent", title: "Diagnostics" });
    const user = fx.messages.append({
      conversationId: conversation.id,
      role: "user",
      content: "inspect",
      runId: null,
    });
    const run = fx.runs.create({
      conversationId: conversation.id,
      agentId: conversation.agentId,
      triggeredByMessageId: user.id,
    });
    fx.runs.appendEvent(run.id, { type: "run.started", agentId: conversation.agentId, model: "gpt-5.4" });
    fx.runs.appendEvent(run.id, {
      type: "tool.planned",
      callId: "call-1",
      tool: "fs.read",
      input: { path: "package.json" },
    });
    fx.runs.appendEvent(run.id, { type: "tool.started", callId: "call-1" });
    fx.runs.appendEvent(run.id, {
      type: "tool.ask",
      callId: "call-1",
      tool: "fs.read",
      reason: "needs approval",
      approvalToken: "approval-1",
    });
    fx.runs.saveTokenUsage(run.id, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    fx.artifacts.create({
      runId: run.id,
      conversationId: conversation.id,
      agentId: conversation.agentId,
      kind: "text",
      title: "final",
      content: "done",
    });
    const childConversation = fx.conversations.create({ agentId: "local-work-agent", title: "Child" });
    fx.subagentSessions.create({
      parentConversationId: conversation.id,
      parentRunId: run.id,
      agentId: conversation.agentId,
      conversationId: childConversation.id,
      label: "child task",
    });

    const res = await fx.app.request("/v1/run-logs?limit=10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.nextOffset).toBeNull();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      conversationTitle: "Diagnostics",
      model: "gpt-5.4",
      eventCount: 4,
      toolCallCount: 1,
      approvalCount: 1,
      artifactCount: 1,
      subagentCount: 1,
      run: {
        id: run.id,
        conversationId: conversation.id,
        agentId: "local-work-agent",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
    });
    fx.cleanup();
  });

  test("filters by status and rejects invalid status", async () => {
    const fx = fresh();
    const conversation = fx.conversations.create({ agentId: "local-work-agent" });
    const user = fx.messages.append({
      conversationId: conversation.id,
      role: "user",
      content: "hello",
      runId: null,
    });
    const run = fx.runs.create({
      conversationId: conversation.id,
      agentId: conversation.agentId,
      triggeredByMessageId: user.id,
    });
    fx.runs.markFailed(run.id, { code: "internal", message: "boom" });

    const failed = await fx.app.request("/v1/run-logs?status=failed");
    expect((await failed.json()).items).toHaveLength(1);

    const active = await fx.app.request("/v1/run-logs?status=active");
    expect((await active.json()).items).toHaveLength(0);

    const invalid = await fx.app.request("/v1/run-logs?status=bad");
    expect(invalid.status).toBe(400);
    fx.cleanup();
  });
});
