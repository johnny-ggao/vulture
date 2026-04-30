import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ConversationStore } from "./conversationStore";
import { MessageStore } from "./messageStore";
import { RunStore } from "./runStore";
import { SubagentSessionStore } from "./subagentSessionStore";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-subagent-store-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const conversations = new ConversationStore(db);
  const messages = new MessageStore(db);
  const runs = new RunStore(db);
  const sessions = new SubagentSessionStore(db, { runs, messages });
  const parent = conversations.create({ agentId: "parent-agent", title: "Parent" });
  const parentMessage = messages.append({
    conversationId: parent.id,
    role: "user",
    content: "delegate this",
    runId: null,
  });
  const parentRun = runs.create({
    conversationId: parent.id,
    agentId: parent.agentId,
    triggeredByMessageId: parentMessage.id,
  });
  const child = conversations.create({ agentId: "child-agent", title: "Child" });
  return {
    db,
    conversations,
    messages,
    runs,
    sessions,
    parent,
    parentRun,
    child,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true });
    },
  };
}

function createChildRun(
  stores: ReturnType<typeof fresh>,
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled",
) {
  const message = stores.messages.append({
    conversationId: stores.child.id,
    role: "user",
    content: `child ${status}`,
    runId: null,
  });
  const run = stores.runs.create({
    conversationId: stores.child.id,
    agentId: stores.child.agentId,
    triggeredByMessageId: message.id,
  });
  if (status === "running") stores.runs.markRunning(run.id);
  if (status === "succeeded") {
    const result = stores.messages.append({
      conversationId: stores.child.id,
      role: "assistant",
      content: "done",
      runId: run.id,
    });
    stores.runs.markSucceeded(run.id, result.id);
  }
  if (status === "failed") stores.runs.markFailed(run.id, { code: "internal", message: "boom" });
  if (status === "cancelled") stores.runs.markCancelled(run.id);
  return run;
}

describe("SubagentSessionStore", () => {
  test("create stores parent and child conversation metadata", () => {
    const stores = fresh();
    const session = stores.sessions.create({
      parentConversationId: stores.parent.id,
      parentRunId: stores.parentRun.id,
      agentId: stores.child.agentId,
      conversationId: stores.child.id,
      label: "Research docs",
    });

    expect(session.id).toStartWith("sub-");
    expect(session).toMatchObject({
      parentConversationId: stores.parent.id,
      parentRunId: stores.parentRun.id,
      agentId: stores.child.agentId,
      conversationId: stores.child.id,
      label: "Research docs",
      status: "active",
      messageCount: 0,
    });
    expect(stores.sessions.get(session.id)).toEqual(session);
    stores.cleanup();
  });

  test("list filters by parent conversation, parent run, agent, and limit", () => {
    const stores = fresh();
    const first = stores.sessions.create({
      parentConversationId: stores.parent.id,
      parentRunId: stores.parentRun.id,
      agentId: "child-agent",
      conversationId: stores.child.id,
      label: "First",
    });
    const otherParent = stores.conversations.create({ agentId: "parent-agent", title: "Other" });
    const otherMessage = stores.messages.append({
      conversationId: otherParent.id,
      role: "user",
      content: "other",
      runId: null,
    });
    const otherRun = stores.runs.create({
      conversationId: otherParent.id,
      agentId: otherParent.agentId,
      triggeredByMessageId: otherMessage.id,
    });
    const otherChild = stores.conversations.create({ agentId: "other-child", title: "Other child" });
    stores.sessions.create({
      parentConversationId: otherParent.id,
      parentRunId: otherRun.id,
      agentId: "other-child",
      conversationId: otherChild.id,
      label: "Second",
    });

    expect(stores.sessions.list({ parentConversationId: stores.parent.id }).map((s) => s.id)).toEqual([
      first.id,
    ]);
    expect(stores.sessions.list({ parentRunId: stores.parentRun.id }).map((s) => s.id)).toEqual([
      first.id,
    ]);
    expect(stores.sessions.list({ agentId: "child-agent", limit: 1 }).map((s) => s.id)).toEqual([
      first.id,
    ]);
    stores.cleanup();
  });

  test("getByConversationId maps a child conversation back to its session", () => {
    const stores = fresh();
    const session = stores.sessions.create({
      parentConversationId: stores.parent.id,
      parentRunId: stores.parentRun.id,
      agentId: stores.child.agentId,
      conversationId: stores.child.id,
      label: "Lookup",
    });

    expect(stores.sessions.getByConversationId(stores.child.id)?.id).toBe(session.id);
    stores.cleanup();
  });

  test("refreshStatus derives active, completed, failed, and cancelled from child runs", () => {
    const stores = fresh();
    const session = stores.sessions.create({
      parentConversationId: stores.parent.id,
      parentRunId: stores.parentRun.id,
      agentId: stores.child.agentId,
      conversationId: stores.child.id,
      label: "Status",
    });

    createChildRun(stores, "running");
    expect(stores.sessions.refreshStatus(session.id)?.status).toBe("active");

    stores.runs.markSucceeded(
      stores.runs.listForConversation(stores.child.id)[0]!.id,
      stores.messages.append({
        conversationId: stores.child.id,
        role: "assistant",
        content: "done",
        runId: stores.runs.listForConversation(stores.child.id)[0]!.id,
      }).id,
    );
    expect(stores.sessions.refreshStatus(session.id)).toMatchObject({
      status: "completed",
      messageCount: 2,
    });

    createChildRun(stores, "failed");
    expect(stores.sessions.refreshStatus(session.id)?.status).toBe("failed");

    createChildRun(stores, "cancelled");
    expect(stores.sessions.refreshStatus(session.id)?.status).toBe("cancelled");
    stores.cleanup();
  });
});
