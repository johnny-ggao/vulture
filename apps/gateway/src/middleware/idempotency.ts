import type { MiddlewareHandler } from "hono";

export const requireIdempotencyKey: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== "POST") return next();
  const key = c.req.header("Idempotency-Key");
  if (!key) {
    return c.json(
      { code: "internal", message: "Idempotency-Key header required" },
      400,
    );
  }
  await next();
};

interface CachedEntry {
  status: number;
  body: string;
  headers: Record<string, string>;
  expiresAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 1000;
const cache = new Map<string, CachedEntry>();

function evict(now: number): void {
  for (const [k, v] of cache) {
    if (v.expiresAt < now) cache.delete(k);
  }
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export function idempotencyCache(): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "POST") return next();
    const key = c.req.header("Idempotency-Key");
    if (!key) return next();
    const now = Date.now();

    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) {
      return new Response(hit.body, { status: hit.status, headers: hit.headers });
    }

    await next();

    const res = c.res;
    if (res && res.status >= 200 && res.status < 300) {
      const body = await res.clone().text();
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));
      cache.set(key, { status: res.status, body, headers, expiresAt: now + TTL_MS });
      evict(now);
    }
  };
}
