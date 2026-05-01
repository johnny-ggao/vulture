import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig } from "../env";
import { createGatewayStores } from "./stores";

const TOKEN = "x".repeat(43);

function freshCfg(): { cfg: GatewayConfig; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "vulture-server-stores-test-"));
  const cfg: GatewayConfig = {
    port: 4099,
    token: TOKEN,
    shellCallbackUrl: "http://127.0.0.1:4199",
    shellPid: 1,
    profileDir: dir,
    privateWorkspaceHomeDir: dir,
  };
  return { cfg, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("createGatewayStores", () => {
  test("initializes migrated stores with default profile and agent", () => {
    const { cfg, cleanup } = freshCfg();
    try {
      const { stores, importResult } = createGatewayStores({
        cfg,
        onSubagentStatusChange: () => undefined,
      });

      expect(importResult).toEqual({ agentsImported: 0, workspacesImported: 0 });
      expect(String(stores.profileStore.get().id)).toBe("default");
      expect(String(stores.agentStore.get("local-work-agent")?.id)).toBe("local-work-agent");
      expect(stores.workspaceStore.list()).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
