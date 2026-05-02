import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ConversationStore } from "../domain/conversationStore";
import { MessageStore } from "../domain/messageStore";
import { RunStore } from "../domain/runStore";
import { SubagentSessionStore } from "../domain/subagentSessionStore";
import { subagentSessionsRouter } from "./subagentSessions";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-subagent-routes-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const conversations = new ConversationStore(db);
  const messages = new MessageStore(db);
  const runs = new RunStore(db);
  const sessions = new SubagentSessionStore(db, { runs, messages });
  const app = subagentSessionsRouter({ sessions, messages, runs });
  const parent = conversations.create({ agentId: "parent-agent", title: "Parent" });
  const parentMessage = messages.append({
    conversationId: parent.id,
    role: "user",
    content: "delegate",
    runId: null,
  });
  const parentRun = runs.create({
    conversationId: parent.id,
    agentId: parent.agentId,
    triggeredByMessageId: parentMessage.id,
  });
  const child = conversations.create({ agentId: "child-agent", title: "Child" });
  const session = sessions.create({
    parentConversationId: parent.id,
    parentRunId: parentRun.id,
    agentId: child.agentId,
    conversationId: child.id,
    label: "Read docs",
    title: "Review SDK docs",
    task: "Read the SDK docs and summarize the useful parts.",
  });
  const childPrompt = messages.append({
    conversationId: child.id,
    role: "user",
    content: "start",
    runId: null,
  });
  const childRun = runs.create({
    conversationId: child.id,
    agentId: child.agentId,
    triggeredByMessageId: childPrompt.id,
  });
  const result = messages.append({
    conversationId: child.id,
    role: "assistant",
    content: "The SDK manager pattern fits this feature.",
    runId: childRun.id,
  });
  runs.markSucceeded(childRun.id, result.id);
  const refreshedSession = sessions.refreshStatus(session.id)!;
  return {
    db,
    app,
    conversations,
    messages,
    runs,
    sessions,
    parent,
    parentRun,
    child,
    session: refreshedSession,
    result,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true });
    },
  };
}

describe("/v1/subagent-sessions", () => {
  test("GET lists filtered subagent sessions", async () => {
    const stores = fresh();

    const res = await stores.app.request(
      `/v1/subagent-sessions?parentConversationId=${stores.parent.id}&limit=5`,
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      items: [
        {
          id: stores.session.id,
          parentConversationId: stores.parent.id,
          parentRunId: stores.parentRun.id,
          agentId: "child-agent",
          conversationId: stores.child.id,
          label: "Read docs",
          title: "Review SDK docs",
          task: "Read the SDK docs and summarize the useful parts.",
          status: "completed",
          resultSummary: "The SDK manager pattern fits this feature.",
          resultMessageId: stores.result.id,
          completedAt: stores.session.completedAt,
          lastError: null,
        },
      ],
    });
    stores.cleanup();
  });

  test("GET /:id returns a session or 404", async () => {
    const stores = fresh();

    const ok = await stores.app.request(`/v1/subagent-sessions/${stores.session.id}`);
    const missing = await stores.app.request("/v1/subagent-sessions/missing");

    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      id: stores.session.id,
      title: "Review SDK docs",
      task: "Read the SDK docs and summarize the useful parts.",
      resultSummary: "The SDK manager pattern fits this feature.",
      resultMessageId: stores.result.id,
      completedAt: stores.session.completedAt,
      lastError: null,
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).code).toBe("subagent_session.not_found");
    stores.cleanup();
  });

  test("GET /:id/messages returns child conversation messages", async () => {
    const stores = fresh();
    stores.messages.append({
      conversationId: stores.child.id,
      role: "user",
      content: "child question",
      runId: null,
    });
    stores.messages.append({
      conversationId: stores.child.id,
      role: "assistant",
      content: "child answer",
      runId: null,
    });

    const res = await stores.app.request(`/v1/subagent-sessions/${stores.session.id}/messages`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      session: {
        id: stores.session.id,
        title: "Review SDK docs",
        task: "Read the SDK docs and summarize the useful parts.",
        resultSummary: "The SDK manager pattern fits this feature.",
        resultMessageId: stores.result.id,
        completedAt: stores.session.completedAt,
        lastError: null,
      },
    });
    expect(body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "child question" }),
        expect.objectContaining({ role: "assistant", content: "child answer" }),
      ]),
    );
    stores.cleanup();
  });

  test("GET lists pending child approvals for active subagent sessions", async () => {
    const stores = fresh();
    const activeChild = stores.conversations.create({ agentId: "child-agent", title: "Active child" });
    const activeSession = stores.sessions.create({
      parentConversationId: stores.parent.id,
      parentRunId: stores.parentRun.id,
      agentId: activeChild.agentId,
      conversationId: activeChild.id,
      label: "Read outside file",
      title: "Read temp file",
      task: "Read /tmp/not-exist-vulture-subagent-file.",
    });
    const prompt = stores.messages.append({
      conversationId: activeChild.id,
      role: "user",
      content: "go",
      runId: null,
    });
    const run = stores.runs.create({
      conversationId: activeChild.id,
      agentId: activeChild.agentId,
      triggeredByMessageId: prompt.id,
    });
    stores.runs.markRunning(run.id);
    stores.runs.appendEvent(run.id, {
      type: "tool.ask",
      callId: "c-read",
      tool: "read",
      reason: "read outside workspace requires approval",
      approvalToken: "tok-read",
    });

    const res = await stores.app.request(
      `/v1/subagent-sessions?parentConversationId=${stores.parent.id}&parentRunId=${stores.parentRun.id}&limit=5`,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: activeSession.id,
        pendingApprovals: [
          {
            runId: run.id,
            callId: "c-read",
            tool: "read",
            reason: "read outside workspace requires approval",
            approvalToken: "tok-read",
            seq: 0,
          },
        ],
      }),
    ]));
    stores.cleanup();
  });
});
