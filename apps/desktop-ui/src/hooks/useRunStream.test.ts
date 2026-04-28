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
  | { type: "run.recoverable"; runId: string; seq: number; createdAt: string; reason: string; message: string }
  | { type: "run.completed"; runId: string; seq: number; createdAt: string; resultMessageId: string; finalText: string }
  | { type: "run.failed"; runId: string; seq: number; createdAt: string; error: { code: string; message: string } };

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

  test("duplicate terminal event flips status without appending", () => {
    const ev: Event = {
      type: "run.failed",
      runId: "r",
      seq: 5,
      createdAt: "2026-04-27T00:00:00.000Z",
      error: { code: "internal", message: "boom" },
    };
    const s = runStreamReducer(
      { ...initial, status: "streaming", lastSeq: 5 },
      { type: "frame", event: ev as never },
    );
    expect(s.status).toBe("failed");
    expect(s.events).toEqual([]);
    expect(s.lastSeq).toBe(5);
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

  test("run.recoverable appends event and flips status to recoverable", () => {
    const ev: Event = {
      type: "run.recoverable",
      runId: "r",
      seq: 4,
      createdAt: "2026-04-27T00:00:00.000Z",
      reason: "incomplete_tool",
      message: "Tool shell.exec may have been interrupted before completion.",
    };
    const s = runStreamReducer(
      { ...initial, status: "streaming" },
      { type: "frame", event: ev as never },
    );
    expect(s.status).toBe("recoverable");
    expect(s.events).toEqual([ev]);
    expect(s.lastSeq).toBe(4);
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

  test("stops reconnect loop after run.recoverable", async () => {
    localStorage.clear();
    let fetchCount = 0;
    let observed: RunStreamState | null = null;
    const recoverable = {
      type: "run.recoverable",
      runId: "r-recoverable",
      seq: 2,
      createdAt: "2026-04-27T00:00:00.000Z",
      reason: "incomplete_tool",
      message: "Tool shell.exec may have been interrupted before completion.",
    };
    const fetchFn = (async () => {
      fetchCount += 1;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `id: 2\nevent: run.recoverable\ndata: ${JSON.stringify(recoverable)}\n\n`,
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
      observed = useRunStream({ client, runId: "r-recoverable", fetch: fetchFn });
      return createElement("div", null, "probe");
    }

    render(createElement(Probe));

    await waitFor(() => {
      expect(observed?.status).toBe("recoverable");
      expect(fetchCount).toBe(1);
    });
  });

  test("stops reconnect loop when a caught-up stream closes for an already failed run", async () => {
    localStorage.clear();
    writeRunLastSeq("r-failed", 3);
    let fetchCount = 0;
    let observed: RunStreamState | null = null;
    const fetchFn = (async () => {
      fetchCount += 1;
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("event: ping\ndata: {}\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;
    const client = {
      base: "http://127.0.0.1:4099",
      token: "x".repeat(43),
      get: async () => ({
        id: "r-failed",
        conversationId: "c",
        agentId: "a",
        status: "failed",
        triggeredByMessageId: "m-user",
        resultMessageId: null,
        startedAt: "2026-04-27T00:00:00.000Z",
        endedAt: "2026-04-27T00:00:01.000Z",
        error: { code: "internal", message: "boom" },
        usage: null,
      }),
    } as ApiClient;

    function Probe() {
      observed = useRunStream({ client, runId: "r-failed", fetch: fetchFn });
      return createElement("div", null, "probe");
    }

    render(createElement(Probe));

    await waitFor(() => {
      expect(observed?.status).toBe("failed");
      expect(fetchCount).toBe(1);
    });
  });

  test("same-run resume preserves prior events and appends recovered output", async () => {
    localStorage.clear();
    let fetchCount = 0;
    let secondLastEventId: string | null = null;
    let observed: RunStreamState | null = null;

    const events = {
      before: {
        type: "text.delta",
        runId: "r-resume",
        seq: 1,
        createdAt: "2026-04-27T00:00:00.000Z",
        text: "before",
      },
      recoverable: {
        type: "run.recoverable",
        runId: "r-resume",
        seq: 2,
        createdAt: "2026-04-27T00:00:00.000Z",
        reason: "incomplete_tool",
        message: "Tool shell.exec may have been interrupted before completion.",
      },
      recovered: {
        type: "run.recovered",
        runId: "r-resume",
        seq: 3,
        createdAt: "2026-04-27T00:00:00.000Z",
        mode: "manual",
        discardPriorDraft: true,
      },
      after: {
        type: "text.delta",
        runId: "r-resume",
        seq: 4,
        createdAt: "2026-04-27T00:00:00.000Z",
        text: "after",
      },
      completed: {
        type: "run.completed",
        runId: "r-resume",
        seq: 5,
        createdAt: "2026-04-27T00:00:00.000Z",
        resultMessageId: "m-r",
        finalText: "after",
      },
    };

    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      fetchCount += 1;
      const batch =
        fetchCount === 1
          ? [events.before, events.recoverable]
          : [events.recovered, events.after, events.completed];
      if (fetchCount === 2) {
        secondLastEventId = new Headers(init?.headers).get("Last-Event-ID");
      }
      const stream = new ReadableStream({
        start(controller) {
          for (const event of batch) {
            controller.enqueue(
              new TextEncoder().encode(
                `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
              ),
            );
          }
          controller.close();
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;
    const client = {
      base: "http://127.0.0.1:4099",
      token: "x".repeat(43),
    } as ApiClient;

    function Probe(props: { reconnectKey: number }) {
      observed = useRunStream({
        client,
        runId: "r-resume",
        fetch: fetchFn,
        reconnectKey: props.reconnectKey,
      });
      return createElement("div", null, "probe");
    }

    const view = render(createElement(Probe, { reconnectKey: 0 }));

    await waitFor(() => {
      expect(observed?.status).toBe("recoverable");
    });

    view.rerender(createElement(Probe, { reconnectKey: 1 }));

    await waitFor(() => {
      expect(observed?.status).toBe("succeeded");
      expect(fetchCount).toBe(2);
    });
    expect(secondLastEventId).toBe("2");
    expect(observed?.events.map((event) => event.type)).toEqual([
      "text.delta",
      "run.recoverable",
      "run.recovered",
      "text.delta",
      "run.completed",
    ]);
  });
});
