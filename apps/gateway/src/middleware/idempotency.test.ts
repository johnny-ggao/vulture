import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { requireIdempotencyKey, idempotencyCache } from "./idempotency";

function makeApp() {
  const app = new Hono();
  app.use("/things", requireIdempotencyKey, idempotencyCache());
  let counter = 0;
  app.post("/things", (c) => {
    counter += 1;
    return c.json({ counter }, 201);
  });
  return { app, getCounter: () => counter };
}

describe("idempotency", () => {
  test("missing Idempotency-Key on POST → 400", async () => {
    const { app } = makeApp();
    const res = await app.request("/things", { method: "POST" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe("internal");
    expect(body.message).toMatch(/Idempotency-Key/);
  });

  test("first POST runs handler; same key replays cached response", async () => {
    const { app, getCounter } = makeApp();
    const res1 = await app.request("/things", {
      method: "POST",
      headers: { "Idempotency-Key": "k1" },
    });
    const res2 = await app.request("/things", {
      method: "POST",
      headers: { "Idempotency-Key": "k1" },
    });
    expect(res1.status).toBe(201);
    expect(res2.status).toBe(201);
    expect(await res1.json()).toEqual({ counter: 1 });
    expect(await res2.json()).toEqual({ counter: 1 });
    expect(getCounter()).toBe(1);
  });

  test("different keys run handler twice", async () => {
    const { app, getCounter } = makeApp();
    await app.request("/things", {
      method: "POST",
      headers: { "Idempotency-Key": "a" },
    });
    await app.request("/things", {
      method: "POST",
      headers: { "Idempotency-Key": "b" },
    });
    expect(getCounter()).toBe(2);
  });
});
