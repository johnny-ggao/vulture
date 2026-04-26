import { Hono } from "hono";
import { authMiddleware, originGuard } from "./middleware/auth";
import { errorBoundary } from "./middleware/error";
import type { GatewayConfig } from "./env";

export function buildServer(cfg: GatewayConfig): Hono {
  const app = new Hono();
  app.use("*", errorBoundary);
  // /healthz is the only no-auth route; mount BEFORE auth middleware.
  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      apiVersion: "v1",
      gatewayVersion: "0.1.0",
      uptimeMs: Math.round(process.uptime() * 1000),
    }),
  );
  app.use("*", originGuard, authMiddleware(cfg.token));
  // Future routes plug in here.
  return app;
}
