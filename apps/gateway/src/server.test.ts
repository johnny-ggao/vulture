import { describe, expect, test } from "bun:test";
import { buildServer } from "./server";
import type { GatewayConfig } from "./env";

const cfg: GatewayConfig = {
  port: 4099,
  token: "x".repeat(43),
  shellCallbackUrl: "http://127.0.0.1:4199",
  shellPid: 1,
  profileDir: "/tmp",
};

describe("gateway server", () => {
  test("/healthz returns ok without auth", async () => {
    const app = buildServer(cfg);
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.apiVersion).toBe("v1");
  });

  test("any other route without token → 401", async () => {
    const app = buildServer(cfg);
    const res = await app.request("/v1/agents");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("auth.token_invalid");
  });

  test("token in query string is rejected (treated as no token)", async () => {
    const app = buildServer(cfg);
    const res = await app.request(`/v1/agents?token=${cfg.token}`);
    expect(res.status).toBe(401);
  });

  test("with valid token → 404 (route not registered yet, but auth passed)", async () => {
    const app = buildServer(cfg);
    const res = await app.request("/v1/agents", {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    // Phase 1 has no /v1/agents route; auth passes then the router 404s.
    expect(res.status).toBe(404);
  });
});
