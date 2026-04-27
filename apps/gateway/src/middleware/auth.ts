import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

const ALLOWED_ORIGINS = [
  "tauri://localhost",       // production Tauri webview
  "http://127.0.0.1:5174",  // dev mode vite (apps/desktop-ui/vite.config.ts)
  "http://localhost:5174",   // dev mode (alternative host)
];

/**
 * CORS-aware origin guard. Handles OPTIONS preflight automatically and
 * rejects disallowed origins with the same JSON error envelope existing
 * tests expect ({code: "auth.origin_invalid", message: ...}, 403).
 */
export const originGuard: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header("Origin");

  // Same-origin or non-browser callers don't send Origin (e.g. curl, Tauri
  // sometimes); skip the CORS dance entirely and let auth middleware decide.
  if (!origin || origin === "null") {
    await next();
    return;
  }

  if (!ALLOWED_ORIGINS.includes(origin)) {
    return c.json(
      { code: "auth.origin_invalid", message: "origin not allowed" },
      403,
    );
  }

  // Use Hono's cors() helper to handle preflight + add ACAO/ACAH headers.
  return cors({
    origin: ALLOWED_ORIGINS,
    allowHeaders: [
      "Authorization",
      "Content-Type",
      "Idempotency-Key",
      "X-Request-Id",
      "Last-Event-ID",
    ],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    credentials: false,
    maxAge: 600,
  })(c, next);
};

export function authMiddleware(expectedToken: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    if (!header.startsWith("Bearer ") || header.slice(7) !== expectedToken) {
      return c.json(
        { code: "auth.token_invalid", message: "missing or invalid token" },
        401,
      );
    }
    await next();
  };
}
