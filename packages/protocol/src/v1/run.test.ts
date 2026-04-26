import { describe, expect, test } from "bun:test";
import { RunSchema, RunEventSchema, type RunEvent } from "./run";

describe("Run + RunEvent", () => {
  test("Run parses minimal", () => {
    const r = RunSchema.parse({
      id: "r-1",
      conversationId: "c-1",
      agentId: "a-1",
      status: "running",
      triggeredByMessageId: "m-1",
      resultMessageId: null,
      startedAt: "2026-04-26T00:00:00.000Z",
      endedAt: null,
      error: null,
    });
    expect(r.status).toBe("running");
  });

  test("RunEvent discriminated union — text.delta", () => {
    const ev: RunEvent = {
      type: "text.delta",
      runId: "r-1" as RunEvent["runId"],
      seq: 1,
      createdAt: "2026-04-26T00:00:00.000Z" as RunEvent["createdAt"],
      text: "hello",
    };
    expect(RunEventSchema.parse(ev).type).toBe("text.delta");
  });

  test("RunEvent — tool.ask requires approvalToken", () => {
    expect(() =>
      RunEventSchema.parse({
        type: "tool.ask",
        runId: "r-1",
        seq: 5,
        createdAt: "2026-04-26T00:00:00.000Z",
        callId: "c1",
        tool: "browser.click",
        reason: "needs approval",
        // approvalToken missing
      }),
    ).toThrow();
  });

  test("RunEvent — run.completed requires resultMessageId + finalText", () => {
    const ev = RunEventSchema.parse({
      type: "run.completed",
      runId: "r-1",
      seq: 99,
      createdAt: "2026-04-26T00:00:00.000Z",
      resultMessageId: "m-2",
      finalText: "Done.",
    });
    expect(ev.type).toBe("run.completed");
  });

  test("RunEvent rejects unknown type", () => {
    expect(() =>
      RunEventSchema.parse({
        type: "tool.unknown",
        runId: "r-1",
        seq: 1,
        createdAt: "2026-04-26T00:00:00.000Z",
      }),
    ).toThrow();
  });
});
