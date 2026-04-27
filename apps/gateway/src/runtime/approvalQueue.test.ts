import { describe, expect, test } from "bun:test";
import { ApprovalQueue } from "./approvalQueue";

describe("ApprovalQueue", () => {
  test("resolve unblocks wait with the decision", async () => {
    const q = new ApprovalQueue();
    const ac = new AbortController();
    const promise = q.wait("c1", ac.signal);
    expect(q.resolve("c1", "allow")).toBe(true);
    expect(await promise).toBe("allow");
  });

  test("resolve before wait returns false (no listener)", () => {
    const q = new ApprovalQueue();
    expect(q.resolve("missing", "allow")).toBe(false);
  });

  test("multiple callIds independent", async () => {
    const q = new ApprovalQueue();
    const ac = new AbortController();
    const a = q.wait("c1", ac.signal);
    const b = q.wait("c2", ac.signal);
    q.resolve("c2", "deny");
    q.resolve("c1", "allow");
    expect(await a).toBe("allow");
    expect(await b).toBe("deny");
  });

  test("abort rejects the promise and cleans up", async () => {
    const q = new ApprovalQueue();
    const ac = new AbortController();
    const promise = q.wait("c1", ac.signal);
    ac.abort();
    await expect(promise).rejects.toThrow(/aborted/);
    expect(q.resolve("c1", "allow")).toBe(false);
  });
});
