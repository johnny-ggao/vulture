import type { MiddlewareHandler } from "hono";

const ALLOWED_ORIGINS = new Set([null, "null", "tauri://localhost"]);

export const originGuard: MiddlewareHandler = async (c, next) => {
  const origin = c.req.header("Origin") ?? null;
  if (!ALLOWED_ORIGINS.has(origin)) {
    return c.json(
      { code: "auth.token_invalid", message: "origin not allowed" },
      403,
    );
  }
  await next();
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
