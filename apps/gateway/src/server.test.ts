import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "./server";
import type { GatewayConfig } from "./env";

const TOKEN = "x".repeat(43);

function freshCfg(): { cfg: GatewayConfig; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "vulture-server-test-"));
  const cfg: GatewayConfig = {
    port: 4099,
    token: TOKEN,
    shellCallbackUrl: "http://127.0.0.1:4199",
    shellPid: 1,
    profileDir: dir,
    privateWorkspaceHomeDir: dir,
  };
  return { cfg, cleanup: () => rmSync(dir, { recursive: true }) };
}

describe("gateway server", () => {
  test("/healthz returns ok without auth", async () => {
    const { cfg, cleanup } = freshCfg();
    const app = buildServer(cfg);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.apiVersion).toBe("v1");
    cleanup();
  });

  test("any other route without token → 401", async () => {
    const { cfg, cleanup } = freshCfg();
    const app = buildServer(cfg);
    const res = await app.request("/v1/agents");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("auth.token_invalid");
    cleanup();
  });

  test("token in query string is rejected (treated as no token)", async () => {
    const { cfg, cleanup } = freshCfg();
    const app = buildServer(cfg);
    const res = await app.request(`/v1/agents?token=${cfg.token}`);
    expect(res.status).toBe(401);
    cleanup();
  });

  test("with valid token → 200 OK on /v1/agents (real route now)", async () => {
    const { cfg, cleanup } = freshCfg();
    const app = buildServer(cfg);
    const res = await app.request("/v1/agents", {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    cleanup();
  });

  test("with valid token → 200 OK on /v1/mcp/servers", async () => {
    const { cfg, cleanup } = freshCfg();
    const app = buildServer(cfg);
    const res = await app.request("/v1/mcp/servers", {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.items)).toBe(true);
    cleanup();
  });

  test("with valid token → 200 OK on /v1/subagent-sessions", async () => {
    const { cfg, cleanup } = freshCfg();
    const app = buildServer(cfg);
    const res = await app.request("/v1/subagent-sessions", {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    cleanup();
  });

  test("with valid token → 200 OK on /v1/web-search/settings", async () => {
    const { cfg, cleanup } = freshCfg();
    const app = buildServer(cfg);
    const res = await app.request("/v1/web-search/settings", {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.settings.provider).toBe("multi");
    cleanup();
  });
});
