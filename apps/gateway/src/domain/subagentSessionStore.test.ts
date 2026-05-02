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

  test("create stores product-facing title and task metadata", () => {
    const stores = fresh();
    const session = stores.sessions.create({
      parentConversationId: stores.parent.id,
      parentRunId: stores.parentRun.id,
      agentId: stores.child.agentId,
      conversationId: stores.child.id,
      label: "Research docs",
      title: "Research SDK docs",
      task: "Read the Agents SDK orchestration docs and summarize the useful bits.",
    });

    expect(session).toMatchObject({
      label: "Research docs",
      title: "Research SDK docs",
      task: "Read the Agents SDK orchestration docs and summarize the useful bits.",
      resultSummary: null,
      resultMessageId: null,
      completedAt: null,
      lastError: null,
    });
    expect(stores.sessions.get(session.id)).toMatchObject({
      title: "Research SDK docs",
      task: "Read the Agents SDK orchestration docs and summarize the useful bits.",
    });
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

  test("refreshStatus captures completed result summary and keeps completedAt stable", () => {
    const stores = fresh();
    const session = stores.sessions.create({
      parentConversationId: stores.parent.id,
      parentRunId: stores.parentRun.id,
      agentId: stores.child.agentId,
      conversationId: stores.child.id,
      label: "Worker",
      title: "Inspect docs",
      task: "Find the relevant details.",
    });
    const childMessage = stores.messages.append({
      conversationId: stores.child.id,
      role: "user",
      content: "go",
      runId: null,
    });
    const childRun = stores.runs.create({
      conversationId: stores.child.id,
      agentId: stores.child.agentId,
      triggeredByMessageId: childMessage.id,
    });
    const result = stores.messages.append({
      conversationId: stores.child.id,
      role: "assistant",
      content: "The child result contains the important detail.",
      runId: childRun.id,
    });
    stores.runs.markSucceeded(childRun.id, result.id);

    const completed = stores.sessions.refreshStatus(session.id);
    expect(completed).toMatchObject({
      status: "completed",
      resultSummary: "The child result contains the important detail.",
      resultMessageId: result.id,
    });
    expect(completed?.completedAt).toBeTruthy();

    const completedAt = completed?.completedAt;
    expect(stores.sessions.refreshStatus(session.id)?.completedAt).toBe(completedAt);
    stores.cleanup();
  });

  test("refreshStatus keeps completed result tied to succeeded run result message", () => {
    const stores = fresh();
    const session = stores.sessions.create({
      parentConversationId: stores.parent.id,
      parentRunId: stores.parentRun.id,
      agentId: stores.child.agentId,
      conversationId: stores.child.id,
      label: "Worker",
    });
    const childMessage = stores.messages.append({
      conversationId: stores.child.id,
      role: "user",
      content: "go",
      runId: null,
    });
    const childRun = stores.runs.create({
      conversationId: stores.child.id,
      agentId: stores.child.agentId,
      triggeredByMessageId: childMessage.id,
    });
    const result = stores.messages.append({
      conversationId: stores.child.id,
      role: "assistant",
      content: "The result linked to the succeeded run.",
      runId: childRun.id,
    });
    stores.runs.markSucceeded(childRun.id, result.id);

    const completed = stores.sessions.refreshStatus(session.id);
    stores.messages.append({
      conversationId: stores.child.id,
      role: "assistant",
      content: "A later unrelated assistant message.",
      runId: null,
    });

    expect(stores.sessions.refreshStatus(session.id)).toMatchObject({
      status: "completed",
      resultSummary: "The result linked to the succeeded run.",
      resultMessageId: result.id,
      completedAt: completed?.completedAt,
    });
    stores.cleanup();
  });

  test("refreshStatus clears terminal metadata when a later child run becomes active", () => {
    const stores = fresh();
    const session = stores.sessions.create({
      parentConversationId: stores.parent.id,
      parentRunId: stores.parentRun.id,
      agentId: stores.child.agentId,
      conversationId: stores.child.id,
      label: "Worker",
    });
    const firstMessage = stores.messages.append({
      conversationId: stores.child.id,
      role: "user",
      content: "go",
      runId: null,
    });
    const firstRun = stores.runs.create({
      conversationId: stores.child.id,
      agentId: stores.child.agentId,
      triggeredByMessageId: firstMessage.id,
    });
    const result = stores.messages.append({
      conversationId: stores.child.id,
      role: "assistant",
      content: "Completed result.",
      runId: firstRun.id,
    });
    stores.runs.markSucceeded(firstRun.id, result.id);
    expect(stores.sessions.refreshStatus(session.id)).toMatchObject({
      status: "completed",
      resultSummary: "Completed result.",
      resultMessageId: result.id,
      completedAt: expect.any(String),
    });

    const secondMessage = stores.messages.append({
      conversationId: stores.child.id,
      role: "user",
      content: "continue",
      runId: null,
    });
    const secondRun = stores.runs.create({
      conversationId: stores.child.id,
      agentId: stores.child.agentId,
      triggeredByMessageId: secondMessage.id,
    });
    stores.runs.markRunning(secondRun.id);

    expect(stores.sessions.refreshStatus(session.id)).toMatchObject({
      status: "active",
      resultSummary: null,
      resultMessageId: null,
      completedAt: null,
      lastError: null,
    });
    stores.cleanup();
  });

  test("refreshStatus captures failure errors", () => {
    const stores = fresh();
    const session = stores.sessions.create({
      parentConversationId: stores.parent.id,
      parentRunId: stores.parentRun.id,
      agentId: stores.child.agentId,
      conversationId: stores.child.id,
      label: "Worker",
    });
    const childMessage = stores.messages.append({
      conversationId: stores.child.id,
      role: "user",
      content: "go",
      runId: null,
    });
    const childRun = stores.runs.create({
      conversationId: stores.child.id,
      agentId: stores.child.agentId,
      triggeredByMessageId: childMessage.id,
    });
    stores.runs.markFailed(childRun.id, { code: "internal", message: "child exploded" });

    expect(stores.sessions.refreshStatus(session.id)).toMatchObject({
      status: "failed",
      lastError: "child exploded",
    });
    stores.cleanup();
  });

  test("onStatusChange fires once when an active session reaches a terminal state", () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-subagent-status-"));
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    const conversations = new ConversationStore(db);
    const messages = new MessageStore(db);
    const runs = new RunStore(db);
    const changes: Array<{ status: string; previousStatus: string }> = [];
    const sessions = new SubagentSessionStore(db, {
      runs,
      messages,
      onStatusChange: ({ session, previousStatus }) => {
        changes.push({ status: session.status, previousStatus });
      },
    });
    const parent = conversations.create({ agentId: "parent-agent", title: "Parent" });
    const parentMsg = messages.append({
      conversationId: parent.id,
      role: "user",
      content: "delegate",
      runId: null,
    });
    const parentRun = runs.create({
      conversationId: parent.id,
      agentId: parent.agentId,
      triggeredByMessageId: parentMsg.id,
    });
    const child = conversations.create({ agentId: "child-agent", title: "Child" });
    const childMsg = messages.append({
      conversationId: child.id,
      role: "user",
      content: "go",
      runId: null,
    });
    const childRun = runs.create({
      conversationId: child.id,
      agentId: child.agentId,
      triggeredByMessageId: childMsg.id,
    });
    runs.markRunning(childRun.id);

    const session = sessions.create({
      parentConversationId: parent.id,
      parentRunId: parentRun.id,
      agentId: child.agentId,
      conversationId: child.id,
      label: "Worker",
    });

    expect(sessions.refreshStatus(session.id)?.status).toBe("active");
    expect(changes).toEqual([]);

    const result = messages.append({
      conversationId: child.id,
      role: "assistant",
      content: "done",
      runId: childRun.id,
    });
    runs.markSucceeded(childRun.id, result.id);

    expect(sessions.refreshStatus(session.id)?.status).toBe("completed");
    expect(changes).toEqual([{ status: "completed", previousStatus: "active" }]);

    // A second refresh on a non-active session should NOT re-fire the callback.
    expect(sessions.refreshStatus(session.id)?.status).toBe("completed");
    expect(changes).toHaveLength(1);

    db.close();
    rmSync(dir, { recursive: true });
  });
});
