import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { authMiddleware, originGuard } from "./auth";

const TOKEN = "x".repeat(43);

function makeApp() {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.use("*", originGuard, authMiddleware(TOKEN));
  app.get("/secret", (c) => c.json({ ok: true }));
  return app;
}

describe("authMiddleware", () => {
  test("/healthz works without token", async () => {
    const res = await makeApp().request("/healthz");
    expect(res.status).toBe(200);
  });

  test("/secret without token → 401", async () => {
    const res = await makeApp().request("/secret");
    expect(res.status).toBe(401);
  });

  test("/secret with wrong token → 401", async () => {
    const res = await makeApp().request("/secret", {
      headers: { Authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  test("/secret with correct token → 200", async () => {
    const res = await makeApp().request("/secret", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  test("/secret with bad Origin → 403", async () => {
    const res = await makeApp().request("/secret", {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: "https://evil.example",
      },
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("auth.origin_invalid");
  });

  test("/secret with Origin tauri://localhost → 200", async () => {
    const res = await makeApp().request("/secret", {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: "tauri://localhost",
      },
    });
    expect(res.status).toBe(200);
  });

  test("/secret with Origin http://127.0.0.1:5174 (dev) → 200", async () => {
    const res = await makeApp().request("/secret", {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: "http://127.0.0.1:5174",
      },
    });
    expect(res.status).toBe(200);
  });

  test("/secret with Origin http://localhost:5174 (dev alt) → 200", async () => {
    const res = await makeApp().request("/secret", {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: "http://localhost:5174",
      },
    });
    expect(res.status).toBe(200);
  });

  test("OPTIONS preflight with allowed origin → 204 + ACAO header", async () => {
    const res = await makeApp().request("/secret", {
      method: "OPTIONS",
      headers: {
        Origin: "http://127.0.0.1:5174",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Authorization, Content-Type",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://127.0.0.1:5174",
    );
  });

  test("OPTIONS preflight without Authorization header → 204 (no auth needed)", async () => {
    const res = await makeApp().request("/secret", {
      method: "OPTIONS",
      headers: {
        Origin: "tauri://localhost",
        "Access-Control-Request-Method": "GET",
      },
    });
    // Preflight must succeed even without a token
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "tauri://localhost",
    );
  });

  test("no Origin header (curl / same-origin) → passes to authMiddleware", async () => {
    // No Origin → originGuard skips CORS dance → authMiddleware rejects no-token
    const res = await makeApp().request("/secret");
    expect(res.status).toBe(401);
  });

  test('Origin: "null" (sandboxed iframe) → passes to authMiddleware', async () => {
    const res = await makeApp().request("/secret", {
      headers: { Origin: "null" },
    });
    // "null" origin is treated as same-origin path; authMiddleware rejects no-token
    expect(res.status).toBe(401);
  });
});
