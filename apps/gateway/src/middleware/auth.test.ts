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
});
