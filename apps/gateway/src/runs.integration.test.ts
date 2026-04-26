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

  test("inflight runs are recovered to failed on second buildServer call", async () => {
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

    // Rebuild server → triggers recoverInflightOnStartup
    const app2 = buildServer(cfg);
    const get = await app2.request("/v1/runs/r-orphan", { headers: auth });
    const run = (await get.json()) as { status: string; error: { code: string } };
    expect(run.status).toBe("failed");
    expect(run.error.code).toBe("internal.gateway_restarted");

    rmSync(dir, { recursive: true });
  });
});
