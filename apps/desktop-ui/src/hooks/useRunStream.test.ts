import { describe, expect, test } from "bun:test";
import { runStreamReducer, type RunStreamState } from "./useRunStream";

type Event =
  | { type: "run.started"; runId: string; seq: number; createdAt: string; agentId: string; model: string }
  | { type: "text.delta"; runId: string; seq: number; createdAt: string; text: string }
  | { type: "run.completed"; runId: string; seq: number; createdAt: string; resultMessageId: string; finalText: string };

const initial: RunStreamState = { status: "idle", events: [], lastSeq: -1, error: null };

describe("runStreamReducer", () => {
  test("connect.start -> connecting", () => {
    const s = runStreamReducer(initial, { type: "connect.start" });
    expect(s.status).toBe("connecting");
  });

  test("frame appends event and tracks seq", () => {
    const ev: Event = {
      type: "run.started",
      runId: "r",
      seq: 0,
      createdAt: "2026-04-27T00:00:00.000Z",
      agentId: "a",
      model: "gpt-5.4",
    };
    const s = runStreamReducer(
      { ...initial, status: "streaming" },
      { type: "frame", event: ev as never },
    );
    expect(s.events).toHaveLength(1);
    expect(s.lastSeq).toBe(0);
  });

  test("frame with seq <= lastSeq is dropped (replay safety)", () => {
    const evA: Event = {
      type: "run.started",
      runId: "r",
      seq: 5,
      createdAt: "2026-04-27T00:00:00.000Z",
      agentId: "a",
      model: "gpt-5.4",
    };
    const evB: Event = {
      type: "text.delta",
      runId: "r",
      seq: 5,
      createdAt: "2026-04-27T00:00:00.000Z",
      text: "x",
    };
    const s1 = runStreamReducer({ ...initial, status: "streaming" }, { type: "frame", event: evA as never });
    const s2 = runStreamReducer(s1, { type: "frame", event: evB as never });
    expect(s2.events).toHaveLength(1);
    expect(s2.lastSeq).toBe(5);
  });

  test("error -> reconnecting; status terminal stays terminal", () => {
    const s1 = runStreamReducer(
      { ...initial, status: "streaming" },
      { type: "error", error: "boom" },
    );
    expect(s1.status).toBe("reconnecting");
    expect(s1.error).toBe("boom");

    const completed: RunStreamState = {
      status: "succeeded",
      events: [],
      lastSeq: 3,
      error: null,
    };
    const s2 = runStreamReducer(completed, { type: "error", error: "late" });
    expect(s2.status).toBe("succeeded"); // already terminal
  });

  test("terminal event flips status", () => {
    const ev: Event = {
      type: "run.completed",
      runId: "r",
      seq: 9,
      createdAt: "2026-04-27T00:00:00.000Z",
      resultMessageId: "m-r",
      finalText: "done",
    };
    const s = runStreamReducer(
      { ...initial, status: "streaming" },
      { type: "frame", event: ev as never },
    );
    expect(s.status).toBe("succeeded");
  });
});
