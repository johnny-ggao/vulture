import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { WorkspaceStore } from "../domain/workspaceStore";
import { workspacesRouter } from "./workspaces";

const TOKEN = "x".repeat(43);
const auth = { Authorization: `Bearer ${TOKEN}` };

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-ws-route-"));
  const wsDir = join(dir, "ws");
  mkdirSync(wsDir);
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const app = workspacesRouter(new WorkspaceStore(db));
  return { app, wsDir, cleanup: () => { db.close(); rmSync(dir, { recursive: true }); } };
}

describe("/v1/workspaces", () => {
  test("POST without Idempotency-Key → 400", async () => {
    const { app, wsDir, cleanup } = freshApp();
    const res = await app.request("/v1/workspaces", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "a", name: "A", path: wsDir }),
    });
    expect(res.status).toBe(400);
    cleanup();
  });

  test("POST creates; GET lists; DELETE removes", async () => {
    const { app, wsDir, cleanup } = freshApp();
    const create = await app.request("/v1/workspaces", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "k1" },
      body: JSON.stringify({ id: "a", name: "A", path: wsDir }),
    });
    expect(create.status).toBe(201);
    const list1 = await app.request("/v1/workspaces", { headers: auth });
    expect((await list1.json()).items).toHaveLength(1);
    const del = await app.request("/v1/workspaces/a", { method: "DELETE", headers: auth });
    expect(del.status).toBe(204);
    const list2 = await app.request("/v1/workspaces", { headers: auth });
    expect((await list2.json()).items).toEqual([]);
    cleanup();
  });

  test("POST with same Idempotency-Key replays cached response", async () => {
    const { app, wsDir, cleanup } = freshApp();
    const headers = { ...auth, "Content-Type": "application/json", "Idempotency-Key": "k2" };
    const body = JSON.stringify({ id: "b", name: "B", path: wsDir });
    const r1 = await app.request("/v1/workspaces", { method: "POST", headers, body });
    const r2 = await app.request("/v1/workspaces", { method: "POST", headers, body });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const list = await app.request("/v1/workspaces", { headers: auth });
    expect((await list.json()).items).toHaveLength(1);
    cleanup();
  });

  test("POST with bad path → 422 workspace.invalid_path", async () => {
    const { app, cleanup } = freshApp();
    const res = await app.request("/v1/workspaces", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": "k3" },
      body: JSON.stringify({ id: "c", name: "C", path: "/no/such" }),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("workspace.invalid_path");
    cleanup();
  });
});
