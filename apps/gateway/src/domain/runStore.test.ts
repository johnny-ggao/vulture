import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ConversationStore } from "./conversationStore";
import { MessageStore } from "./messageStore";
import { RunStore } from "./runStore";

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-run-store-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const convs = new ConversationStore(db);
  const msgs = new MessageStore(db);
  const runs = new RunStore(db);
  const c = convs.create({ agentId: "a-1" });
  const userMsg = msgs.append({
    conversationId: c.id,
    role: "user",
    content: "hi",
    runId: null,
  });
  return { db, runs, c, userMsg, cleanup: () => { db.close(); rmSync(dir, { recursive: true }); } };
}

function freshRun(runs: RunStore, c: { id: string; agentId: string }, userMsg: { id: string }) {
  return runs.create({
    conversationId: c.id,
    agentId: c.agentId,
    triggeredByMessageId: userMsg.id,
  });
}

describe("RunStore", () => {
  test("create + get + transition to succeeded", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    expect(r.status).toBe("queued");
    runs.markRunning(r.id);
    expect(runs.get(r.id)?.status).toBe("running");
    runs.markSucceeded(r.id, "m-result");
    const final = runs.get(r.id)!;
    expect(final.status).toBe("succeeded");
    expect(final.resultMessageId as string).toBe("m-result");
    cleanup();
  });

  test("saveTokenUsage stores run token totals", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = freshRun(runs, c, userMsg);

    runs.saveTokenUsage(r.id, {
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
    });

    expect(runs.get(r.id)?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
    });
    expect(runs.listForConversation(c.id)[0].usage?.totalTokens).toBe(125);
    cleanup();
  });

  test("markFailed records error_json", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    runs.markFailed(r.id, { code: "internal", message: "boom" });
    const final = runs.get(r.id)!;
    expect(final.status).toBe("failed");
    expect(final.error?.code).toBe("internal");
    cleanup();
  });

  test("malformed error_json returns failed run with null error", () => {
    const { db, runs, c, userMsg, cleanup } = fresh();
    const r = freshRun(runs, c, userMsg);
    runs.markFailed(r.id, { code: "internal", message: "boom" });
    db.query("UPDATE runs SET error_json = ? WHERE id = ?").run("{bad-json", r.id);

    expect(() => runs.get(r.id)).not.toThrow();
    const recovered = runs.get(r.id)!;
    expect(recovered.status).toBe("failed");
    expect(recovered.error).toBe(null);
    expect(() => runs.listForConversation(c.id)).not.toThrow();
    cleanup();
  });

  test("schema-invalid error_json returns failed run with null error", () => {
    const { db, runs, c, userMsg, cleanup } = fresh();
    const r = freshRun(runs, c, userMsg);
    runs.markFailed(r.id, { code: "internal", message: "boom" });
    db.query("UPDATE runs SET error_json = ? WHERE id = ?").run(JSON.stringify({ code: 123 }), r.id);

    const recovered = runs.get(r.id)!;
    expect(recovered.status).toBe("failed");
    expect(recovered.error).toBe(null);
    cleanup();
  });

  test("recoverInflightOnStartup sweeps queued/running → failed", () => {
    const { db, runs, c, userMsg, cleanup } = fresh();
    const r = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    runs.markRunning(r.id);
    const fresh2 = new RunStore(db);
    const swept = fresh2.recoverInflightOnStartup();
    expect(swept).toBe(1);
    expect(runs.get(r.id)?.status).toBe("failed");
    expect(runs.get(r.id)?.error?.code).toBe("internal.gateway_restarted");
    cleanup();
  });

  test("listForConversation returns newest active run first", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const old = freshRun(runs, c, userMsg);
    runs.markRunning(old.id);
    const done = freshRun(runs, c, userMsg);
    runs.markSucceeded(done.id, "m-result");
    const active = freshRun(runs, c, userMsg);
    runs.markRunning(active.id);

    const items = runs.listForConversation(c.id, { status: "running" });

    expect(items.map((r) => r.id)).toEqual([active.id, old.id]);
    cleanup();
  });

  test("listForConversation status=active includes queued and running", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const queued = freshRun(runs, c, userMsg);
    const running = freshRun(runs, c, userMsg);
    runs.markRunning(running.id);
    const failed = freshRun(runs, c, userMsg);
    runs.markFailed(failed.id, { code: "internal", message: "boom" });

    const items = runs.listForConversation(c.id, { status: "active" });

    expect(items.map((r) => r.id)).toEqual([running.id, queued.id]);
    cleanup();
  });

  test("save + load recovery state", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = freshRun(runs, c, userMsg);

    runs.saveRecoveryState(r.id, {
      schemaVersion: 1,
      sdkState: "sdk-state-1",
      metadata: {
        runId: r.id,
        conversationId: c.id,
        agentId: c.agentId,
        model: "gpt-5.4",
        systemPrompt: "system",
        userInput: "hi",
        workspacePath: "/tmp/work",
        providerKind: "api_key",
        updatedAt: "2026-04-27T00:00:00.000Z",
      },
      checkpointSeq: 7,
      activeTool: null,
    });

    expect(runs.getRecoveryState(r.id)).toMatchObject({
      schemaVersion: 1,
      sdkState: "sdk-state-1",
      checkpointSeq: 7,
      activeTool: null,
    });
    cleanup();
  });

  test("corrupt recovery JSON returns null", () => {
    const { db, runs, c, userMsg, cleanup } = fresh();
    const r = freshRun(runs, c, userMsg);
    db.query(
      `INSERT INTO run_recovery_state(
         run_id, schema_version, sdk_state, metadata_json, checkpoint_seq, active_tool_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(r.id, 1, "sdk-state-1", "{bad-json", 7, null, "2026-04-27T00:00:00.000Z");

    expect(() => runs.getRecoveryState(r.id)).not.toThrow();
    expect(runs.getRecoveryState(r.id)).toBe(null);
    cleanup();
  });

  test("saveRecoveryState upsert overwrites prior state", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = freshRun(runs, c, userMsg);
    const metadata = {
      runId: r.id,
      conversationId: c.id,
      agentId: c.agentId,
      model: "gpt-5.4",
      systemPrompt: "system",
      userInput: "hi",
      workspacePath: "/tmp/work",
      providerKind: "api_key" as const,
      updatedAt: "2026-04-27T00:00:00.000Z",
    };

    runs.saveRecoveryState(r.id, {
      schemaVersion: 1,
      sdkState: "sdk-state-1",
      metadata,
      checkpointSeq: 7,
      activeTool: null,
    });
    runs.saveRecoveryState(r.id, {
      schemaVersion: 1,
      sdkState: "sdk-state-2",
      metadata,
      checkpointSeq: 9,
      activeTool: {
        callId: "c2",
        tool: "shell.exec",
        input: { cmd: "pwd" },
        approvalToken: "approval-1",
        startedSeq: 8,
      },
    });

    expect(runs.getRecoveryState(r.id)).toMatchObject({
      sdkState: "sdk-state-2",
      checkpointSeq: 9,
      activeTool: {
        callId: "c2",
        tool: "shell.exec",
        input: { cmd: "pwd" },
        approvalToken: "approval-1",
        startedSeq: 8,
      },
    });
    cleanup();
  });

  test("clearRecoveryState deletes recovery state", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = freshRun(runs, c, userMsg);
    runs.saveRecoveryState(r.id, {
      schemaVersion: 1,
      sdkState: "sdk-state-1",
      metadata: {
        runId: r.id,
        conversationId: c.id,
        agentId: c.agentId,
        model: "gpt-5.4",
        systemPrompt: "system",
        userInput: "hi",
        workspacePath: "/tmp/work",
        providerKind: "api_key",
        updatedAt: "2026-04-27T00:00:00.000Z",
      },
      checkpointSeq: 7,
      activeTool: null,
    });

    runs.clearRecoveryState(r.id);

    expect(runs.getRecoveryState(r.id)).toBe(null);
    cleanup();
  });

  test("markRecoverable changes status without ending the run", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = freshRun(runs, c, userMsg);
    runs.markRunning(r.id);
    runs.markRecoverable(r.id);
    const recovered = runs.get(r.id)!;
    expect(recovered.status).toBe("recoverable");
    expect(recovered.endedAt).toBe(null);
    cleanup();
  });

  test("claimRecoverable atomically transitions only recoverable runs to running", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const recoverable = freshRun(runs, c, userMsg);
    runs.markRecoverable(recoverable.id);
    const queued = freshRun(runs, c, userMsg);

    expect(runs.claimRecoverable(recoverable.id)).toBe(true);
    expect(runs.get(recoverable.id)?.status).toBe("running");
    expect(runs.claimRecoverable(recoverable.id)).toBe(false);
    expect(runs.claimRecoverable(queued.id)).toBe(false);
    expect(runs.get(queued.id)?.status).toBe("queued");
    cleanup();
  });

  test("active filter includes recoverable runs", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = freshRun(runs, c, userMsg);
    runs.markRecoverable(r.id);
    expect(runs.listForConversation(c.id, { status: "active" }).map((x) => x.id)).toContain(r.id);
    cleanup();
  });

  test("listInflight returns queued and running runs but excludes recoverable runs", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const queued = freshRun(runs, c, userMsg);
    const running = freshRun(runs, c, userMsg);
    runs.markRunning(running.id);
    const recoverable = freshRun(runs, c, userMsg);
    runs.markRecoverable(recoverable.id);
    const failed = freshRun(runs, c, userMsg);
    runs.markFailed(failed.id, { code: "internal", message: "boom" });

    expect(runs.listInflight().map((x) => x.id)).toEqual([queued.id, running.id]);
    cleanup();
  });

  test("latestSeq returns -1 with no events and latest seq after events", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = freshRun(runs, c, userMsg);
    expect(runs.latestSeq(r.id)).toBe(-1);
    runs.appendEvent(r.id, { type: "text.delta", text: "hello" });
    runs.appendEvent(r.id, { type: "text.delta", text: " world" });
    expect(runs.latestSeq(r.id)).toBe(1);
    cleanup();
  });

  test("detects terminal tool event for callId", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = freshRun(runs, c, userMsg);
    runs.appendEvent(r.id, { type: "tool.started", callId: "c1" });
    expect(runs.hasTerminalToolEvent(r.id, "c1")).toBe(false);
    runs.appendEvent(r.id, { type: "tool.completed", callId: "c1", output: "ok" });
    expect(runs.hasTerminalToolEvent(r.id, "c1")).toBe(true);
    cleanup();
  });

  test("detects failed terminal tool event for callId", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = freshRun(runs, c, userMsg);
    runs.appendEvent(r.id, {
      type: "tool.failed",
      callId: "c1",
      error: { code: "internal", message: "boom" },
    });
    expect(runs.hasTerminalToolEvent(r.id, "c1")).toBe(true);
    cleanup();
  });

  test("hasTerminalToolEvent ignores malformed payload_json", () => {
    const { db, runs, c, userMsg, cleanup } = fresh();
    const r = freshRun(runs, c, userMsg);
    db.query(
      "INSERT INTO run_events(run_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(r.id, 0, "tool.completed", "{bad-json", "2026-04-27T00:00:00.000Z");
    db.query(
      "INSERT INTO run_events(run_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      r.id,
      1,
      "tool.completed",
      JSON.stringify({
        type: "tool.completed",
        runId: r.id,
        seq: 1,
        createdAt: "2026-04-27T00:00:01.000Z",
        callId: "c1",
        output: "ok",
      }),
      "2026-04-27T00:00:01.000Z",
    );

    expect(() => runs.hasTerminalToolEvent(r.id, "missing")).not.toThrow();
    expect(runs.hasTerminalToolEvent(r.id, "missing")).toBe(false);
    expect(runs.hasTerminalToolEvent(r.id, "c1")).toBe(true);
    cleanup();
  });

  test("appendEvent + listEventsAfter (in-memory + persisted)", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r = runs.create({
      conversationId: c.id,
      agentId: c.agentId,
      triggeredByMessageId: userMsg.id,
    });
    runs.appendEvent(r.id, { type: "run.started", agentId: c.agentId, model: "gpt-5.4" });
    runs.appendEvent(r.id, { type: "text.delta", text: "hello " });
    const all = runs.listEventsAfter(r.id, -1);
    expect(all.length).toBe(2);
    expect(all[0].seq).toBe(0);
    const after = runs.listEventsAfter(r.id, 0);
    expect(after.length).toBe(1);
    expect(after[0].type).toBe("text.delta");
    cleanup();
  });

  test("listEventsAfter skips malformed payload_json", () => {
    const { db, runs, c, userMsg, cleanup } = fresh();
    const r = freshRun(runs, c, userMsg);
    db.query(
      "INSERT INTO run_events(run_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(r.id, 0, "text.delta", "{bad-json", "2026-04-27T00:00:00.000Z");
    db.query(
      "INSERT INTO run_events(run_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      r.id,
      1,
      "text.delta",
      JSON.stringify({
        type: "text.delta",
        runId: r.id,
        seq: 1,
        createdAt: "2026-04-27T00:00:01.000Z",
        text: "valid",
      }),
      "2026-04-27T00:00:01.000Z",
    );

    expect(() => runs.listEventsAfter(r.id, -1)).not.toThrow();
    expect(runs.listEventsAfter(r.id, -1).map((event) => event.seq)).toEqual([1]);
    cleanup();
  });

  test("listEventsAfter skips schema-invalid payload_json", () => {
    const { db, runs, c, userMsg, cleanup } = fresh();
    const r = freshRun(runs, c, userMsg);
    db.query(
      "INSERT INTO run_events(run_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(r.id, 0, "text.delta", JSON.stringify({ foo: "bar" }), "2026-04-27T00:00:00.000Z");
    db.query(
      "INSERT INTO run_events(run_id, seq, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(
      r.id,
      1,
      "text.delta",
      JSON.stringify({
        type: "text.delta",
        runId: r.id,
        seq: 1,
        createdAt: "2026-04-27T00:00:01.000Z",
        text: "valid",
      }),
      "2026-04-27T00:00:01.000Z",
    );

    expect(runs.listEventsAfter(r.id, -1).map((event) => event.seq)).toEqual([1]);
    cleanup();
  });

  test("subscribe receives notification on appendEvent + unsubscribe stops it", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const run = freshRun(runs, c, userMsg);

    let calls = 0;
    const unsubscribe = runs.subscribe(run.id, () => { calls += 1; });
    runs.appendEvent(run.id, { type: "text.delta", text: "hi" });
    expect(calls).toBe(1);
    runs.appendEvent(run.id, { type: "text.delta", text: "x" });
    expect(calls).toBe(2);
    unsubscribe();
    runs.appendEvent(run.id, { type: "text.delta", text: "y" });
    expect(calls).toBe(2);

    cleanup();
  });

  test("subscribe is per-run; events for other runs don't notify", () => {
    const { runs, c, userMsg, cleanup } = fresh();
    const r1 = freshRun(runs, c, userMsg);
    const r2 = freshRun(runs, c, userMsg);

    let r1calls = 0;
    let r2calls = 0;
    runs.subscribe(r1.id, () => { r1calls += 1; });
    runs.subscribe(r2.id, () => { r2calls += 1; });
    runs.appendEvent(r1.id, { type: "text.delta", text: "1" });
    runs.appendEvent(r2.id, { type: "text.delta", text: "2" });
    expect(r1calls).toBe(1);
    expect(r2calls).toBe(1);

    cleanup();
  });
});
