import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "./server";

const TOKEN = "x".repeat(43);

function makeServer() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-runs-int-"));
  const app = buildServer({
    port: 4099,
    token: TOKEN,
    shellCallbackUrl: "http://127.0.0.1:4199",
    shellPid: process.pid,
    profileDir: dir,
  });
  return { app, dir, cleanup: () => rmSync(dir, { recursive: true }) };
}

const auth = { Authorization: `Bearer ${TOKEN}` };

describe("end-to-end run flow", () => {
  test("POST conversation → POST run → poll until succeeded; messages list shows assistant", async () => {
    const { app, cleanup } = makeServer();

    // 1. Create conversation (using the default local-work-agent that AgentStore seeds)
    const cRes = await app.request("/v1/conversations", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "ck" },
      body: JSON.stringify({ agentId: "local-work-agent" }),
    });
    expect(cRes.status).toBe(201);
    const conv = (await cRes.json()) as { id: string };

    // 2. Post a message → triggers run
    const rRes = await app.request(`/v1/conversations/${conv.id}/runs`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "rk" },
      body: JSON.stringify({ input: "ping" }),
    });
    expect(rRes.status).toBe(202);
    const { run, message, eventStreamUrl } = (await rRes.json()) as {
      run: { id: string; status: string };
      message: { role: string };
      eventStreamUrl: string;
    };
    expect(run.id).toBeTruthy();
    expect(message.role).toBe("user");
    expect(eventStreamUrl).toContain(`/v1/runs/${run.id}/events`);

    // 3. Poll run state until terminal (stub LLM completes immediately, but
    // orchestrator runs async — give it a few iterations)
    let final: { status: string } = run;
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const get = await app.request(`/v1/runs/${run.id}`, { headers: auth });
      final = (await get.json()) as { status: string };
      if (["succeeded", "failed", "cancelled"].includes(final.status)) break;
    }
    expect(final.status).toBe("succeeded");

    // 4. Messages list should include user + assistant
    const msgs = await app.request(`/v1/conversations/${conv.id}/messages`, { headers: auth });
    const items = ((await msgs.json()) as { items: Array<{ role: string }> }).items;
    expect(items.map((m) => m.role)).toEqual(["user", "assistant"]);

    cleanup();
  });

  test("inflight runs without recovery state fail on second buildServer call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-runs-recovery-"));
    const cfg = {
      port: 4099,
      token: TOKEN,
      shellCallbackUrl: "http://127.0.0.1:4199",
      shellPid: process.pid,
      profileDir: dir,
    };
    const app1 = buildServer(cfg);
    const cRes = await app1.request("/v1/conversations", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "rk1" },
      body: JSON.stringify({ agentId: "local-work-agent" }),
    });
    const conv = (await cRes.json()) as { id: string };

    // Manually inject an inflight run via the underlying SQLite — simulate
    // the gateway dying mid-run before any cleanup ran. We do this on the
    // same db file used by the gateway, then rebuild the server to verify
    // the recovery sweep marks it as failed.
    const { openDatabase } = await import("./persistence/sqlite");
    const { applyMigrations } = await import("./persistence/migrate");
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    db.query(
      `INSERT INTO runs(id, conversation_id, agent_id, status, triggered_by_message_id, started_at)
       VALUES (?, ?, ?, 'running', 'm-fake', '2026-04-26T00:00:00.000Z')`,
    ).run("r-orphan", conv.id, "local-work-agent");
    db.close();

    // Rebuild server -> startup recovery classifies the orphan as failed.
    const app2 = buildServer(cfg);
    const get = await app2.request("/v1/runs/r-orphan", { headers: auth });
    const run = (await get.json()) as { status: string; error: { code: string } };
    expect(run.status).toBe("failed");
    expect(run.error.code).toBe("internal.recovery_state_unavailable");

    rmSync(dir, { recursive: true });
  });

  test("startup auto-resumes a valid model checkpoint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-runs-auto-resume-"));
    const cfg = {
      port: 4099,
      token: TOKEN,
      shellCallbackUrl: "http://127.0.0.1:4199",
      shellPid: process.pid,
      profileDir: dir,
    };
    const app1 = buildServer(cfg);
    const cRes = await app1.request("/v1/conversations", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "auto-c" },
      body: JSON.stringify({ agentId: "local-work-agent" }),
    });
    const conv = (await cRes.json()) as { id: string };

    const { openDatabase } = await import("./persistence/sqlite");
    const { applyMigrations } = await import("./persistence/migrate");
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    db.query(
      `INSERT INTO runs(id, conversation_id, agent_id, status, triggered_by_message_id, started_at)
       VALUES (?, ?, ?, 'running', 'm-fake', '2026-04-26T00:00:00.000Z')`,
    ).run("r-auto", conv.id, "local-work-agent");
    db.query(
      `INSERT INTO run_recovery_state(
         run_id, schema_version, sdk_state, metadata_json, checkpoint_seq, active_tool_json, updated_at
       ) VALUES (?, 1, ?, ?, 0, NULL, ?)`,
    ).run(
      "r-auto",
      "sdk-state",
      JSON.stringify({
        runId: "r-auto",
        conversationId: conv.id,
        agentId: "local-work-agent",
        model: "gpt-5.4",
        systemPrompt: "system",
        userInput: "resume me",
        workspacePath: "",
        providerKind: "stub",
        updatedAt: "2026-04-27T00:00:00.000Z",
      }),
      "2026-04-27T00:00:00.000Z",
    );
    db.close();

    const app2 = buildServer(cfg);
    let run: { status: string } = { status: "running" };
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
      const get = await app2.request("/v1/runs/r-auto", { headers: auth });
      run = (await get.json()) as { status: string };
      if (["succeeded", "failed", "cancelled", "recoverable"].includes(run.status)) break;
    }
    expect(run.status).toBe("succeeded");

    rmSync(dir, { recursive: true });
  });

  test("startup keeps incomplete active tool runs recoverable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vulture-runs-tool-recoverable-"));
    const cfg = {
      port: 4099,
      token: TOKEN,
      shellCallbackUrl: "http://127.0.0.1:4199",
      shellPid: process.pid,
      profileDir: dir,
    };
    const app1 = buildServer(cfg);
    const cRes = await app1.request("/v1/conversations", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "tool-c" },
      body: JSON.stringify({ agentId: "local-work-agent" }),
    });
    const conv = (await cRes.json()) as { id: string };

    const { openDatabase } = await import("./persistence/sqlite");
    const { applyMigrations } = await import("./persistence/migrate");
    const db = openDatabase(join(dir, "data.sqlite"));
    applyMigrations(db);
    db.query(
      `INSERT INTO runs(id, conversation_id, agent_id, status, triggered_by_message_id, started_at)
       VALUES (?, ?, ?, 'running', 'm-fake', '2026-04-26T00:00:00.000Z')`,
    ).run("r-tool", conv.id, "local-work-agent");
    db.query(
      `INSERT INTO run_recovery_state(
         run_id, schema_version, sdk_state, metadata_json, checkpoint_seq, active_tool_json, updated_at
       ) VALUES (?, 1, ?, ?, 0, ?, ?)`,
    ).run(
      "r-tool",
      "sdk-state",
      JSON.stringify({
        runId: "r-tool",
        conversationId: conv.id,
        agentId: "local-work-agent",
        model: "gpt-5.4",
        systemPrompt: "system",
        userInput: "resume me",
        workspacePath: "",
        providerKind: "stub",
        updatedAt: "2026-04-27T00:00:00.000Z",
      }),
      JSON.stringify({ callId: "tc-1", tool: "shell.exec", input: {}, startedSeq: 0 }),
      "2026-04-27T00:00:00.000Z",
    );
    db.close();

    const app2 = buildServer(cfg);
    const get = await app2.request("/v1/runs/r-tool", { headers: auth });
    const run = (await get.json()) as { status: string };
    expect(run.status).toBe("recoverable");

    rmSync(dir, { recursive: true });
  });
});
