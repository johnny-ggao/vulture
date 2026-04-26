import type { MiddlewareHandler } from "hono";

export const errorBoundary: MiddlewareHandler = async (c, next) => {
  try {
    await next();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[gateway] uncaught:", err);
    return c.json({ code: "internal", message }, 500);
  }
};
