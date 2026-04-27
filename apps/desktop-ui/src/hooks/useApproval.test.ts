import { describe, expect, test } from "bun:test";
import { extractPendingApprovals } from "./useApproval";
import type { AnyRunEvent } from "./useRunStream";

const ask = (callId: string, seq: number): AnyRunEvent => ({
  type: "tool.ask",
  runId: "r",
  seq,
  createdAt: "2026-04-27T00:00:00.000Z",
  callId,
  tool: "shell.exec",
  reason: "test",
  approvalToken: `tok-${callId}`,
});
const completed = (callId: string, seq: number): AnyRunEvent => ({
  type: "tool.completed",
  runId: "r",
  seq,
  createdAt: "2026-04-27T00:00:00.000Z",
  callId,
  output: {},
});
const failed = (callId: string, seq: number): AnyRunEvent => ({
  type: "tool.failed",
  runId: "r",
  seq,
  createdAt: "2026-04-27T00:00:00.000Z",
  callId,
  error: { code: "x", message: "y" },
});

describe("extractPendingApprovals", () => {
  test("returns asks not yet superseded", () => {
    const events = [ask("a", 1), ask("b", 2)];
    expect(extractPendingApprovals(events).map((p) => p.callId)).toEqual(["a", "b"]);
  });

  test("ask superseded by completed/failed is dropped", () => {
    const events = [ask("a", 1), completed("a", 5), ask("b", 2)];
    expect(extractPendingApprovals(events).map((p) => p.callId)).toEqual(["b"]);
  });

  test("ask superseded by tool.failed is dropped", () => {
    const events = [ask("a", 1), failed("a", 6)];
    expect(extractPendingApprovals(events)).toEqual([]);
  });
});
