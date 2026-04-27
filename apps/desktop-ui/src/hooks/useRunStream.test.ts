import { describe, expect, test } from "bun:test";
import { render, waitFor } from "@testing-library/react/pure";
import { createElement } from "react";
import {
  parseRunEventFrame,
  runStreamReducer,
  useRunStream,
  type RunStreamState,
} from "./useRunStream";
import { writeRunLastSeq } from "../chat/recoveryState";
import type { ApiClient } from "../api/client";

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

describe("parseRunEventFrame", () => {
  test("ignores SSE ping frames", () => {
    expect(parseRunEventFrame({ id: "", event: "ping", data: "{}" })).toBeNull();
  });

  test("parses run event data", () => {
    const event = {
      type: "text.delta",
      runId: "r",
      seq: 1,
      createdAt: "2026-04-27T00:00:00.000Z",
      text: "hello",
    };
    expect(parseRunEventFrame({ id: "1", event: "text.delta", data: JSON.stringify(event) })).toEqual(event);
  });
});

describe("useRunStream recovery", () => {
  test("uses persisted last seq as Last-Event-ID when reconnecting after remount", async () => {
    localStorage.clear();
    writeRunLastSeq("r-restore", 7);

    let capturedLastEventId: string | null = null;
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      capturedLastEventId = headers.get("Last-Event-ID");
      const completed = {
        type: "run.completed",
        runId: "r-restore",
        seq: 8,
        createdAt: "2026-04-27T00:00:00.000Z",
        resultMessageId: "m-1",
        finalText: "done",
      };
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `id: 8\nevent: run.completed\ndata: ${JSON.stringify(completed)}\n\n`,
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;
    const client = {
      base: "http://127.0.0.1:4099",
      token: "x".repeat(43),
    } as ApiClient;

    function Probe() {
      useRunStream({ client, runId: "r-restore", fetch: fetchFn });
      return createElement("div", null, "probe");
    }

    render(createElement(Probe));

    await waitFor(() => {
      expect(capturedLastEventId).toBe("7");
    });
  });
});
