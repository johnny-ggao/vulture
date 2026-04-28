import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { ProfileStore } from "./profileStore";
import type { ProfileId, AgentId } from "@vulture/protocol/src/v1/profile";

function freshStore(profileDir?: string) {
  const dir = mkdtempSync(join(tmpdir(), "vulture-profile-store-"));
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  return {
    dir,
    store: new ProfileStore(db, profileDir),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true });
      if (profileDir && profileDir !== dir) rmSync(profileDir, { recursive: true });
    },
  };
}

describe("ProfileStore", () => {
  test("ensures default profile exists on first read", () => {
    const { store, cleanup } = freshStore();
    const p = store.get();
    expect(p.id).toBe("default" as ProfileId);
    expect(p.name).toBe("Default");
    expect(p.activeAgentId).toBe("local-work-agent" as AgentId);
    cleanup();
  });

  test("initializes profile from profile.json when profileDir is provided", () => {
    const profileDir = mkdtempSync(join(tmpdir(), "vulture-profile-dir-"));
    writeFileSync(
      join(profileDir, "profile.json"),
      JSON.stringify({
        id: "work",
        name: "Work",
        openai_secret_ref: "vulture:profile:work:openai",
        active_agent_id: "local-work-agent",
      }),
    );
    const { store, cleanup } = freshStore(profileDir);

    const p = store.get();

    expect(p.id).toBe("work" as ProfileId);
    expect(p.name).toBe("Work");
    expect(p.activeAgentId).toBe("local-work-agent" as AgentId);
    cleanup();
  });

  test("update name", () => {
    const { store, cleanup } = freshStore();
    store.get();
    const updated = store.update({ name: "Renamed" });
    expect(updated.name).toBe("Renamed");
    expect(store.get().name).toBe("Renamed");
    cleanup();
  });

  test("update activeAgentId to null", () => {
    const { store, cleanup } = freshStore();
    store.get();
    const updated = store.update({ activeAgentId: null });
    expect(updated.activeAgentId).toBeNull();
    cleanup();
  });
});
