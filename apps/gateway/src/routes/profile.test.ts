import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ProfileStore } from "../domain/profileStore";
import { profileRouter } from "./profile";

const TOKEN = "x".repeat(43);
const auth = { Authorization: `Bearer ${TOKEN}` };

function freshApp() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-profile-route-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  const app = profileRouter(new ProfileStore(db));
  return {
    app,
    cleanup: () => { db.close(); rmSync(dir, { recursive: true }); },
  };
}

describe("/v1/profile route", () => {
  test("GET returns the default profile", async () => {
    const { app, cleanup } = freshApp();
    const res = await app.request("/v1/profile", { headers: auth });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe("default");
    cleanup();
  });

  test("PATCH updates name", async () => {
    const { app, cleanup } = freshApp();
    await app.request("/v1/profile", { headers: auth });
    const res = await app.request("/v1/profile", {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).name).toBe("Renamed");
    cleanup();
  });

  test("PATCH rejects unknown field with 400", async () => {
    const { app, cleanup } = freshApp();
    const res = await app.request("/v1/profile", {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ wat: "no" }),
    });
    expect(res.status).toBe(400);
    cleanup();
  });
});
