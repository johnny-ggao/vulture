import { describe, expect, test } from "bun:test";
import type { AnyRunEvent } from "../hooks/useRunStream";
import { retainedRunEventsForTerminalRun, visibleRunEventsForChat } from "./visibleRunEvents";

const ev = (overrides: Partial<AnyRunEvent>): AnyRunEvent => ({
  type: "text.delta",
  runId: "r-1",
  seq: 0,
  createdAt: "2026-04-28T00:00:00.000Z",
  ...overrides,
});

describe("visibleRunEvents", () => {
  test("terminal runs retain tool blocks but drop transient assistant text", () => {
    const events = [
      ev({ type: "text.delta", seq: 0, text: "draft" }),
      ev({ type: "tool.planned", seq: 1, callId: "c1", tool: "read", input: {} }),
      ev({ type: "tool.completed", seq: 2, callId: "c1", output: { content: "ok" } }),
      ev({ type: "run.completed", seq: 3, resultMessageId: "m-1", finalText: "done" }),
    ];

    expect(retainedRunEventsForTerminalRun(events).map((event) => event.type)).toEqual([
      "tool.planned",
      "tool.completed",
    ]);
  });

  test("chat shows retained terminal events after active run is cleared", () => {
    const retained = [
      ev({ type: "tool.planned", seq: 1, callId: "c1", tool: "read", input: {} }),
      ev({ type: "tool.completed", seq: 2, callId: "c1", output: { content: "ok" } }),
    ];

    expect(
      visibleRunEventsForChat({
        activeRunId: null,
        activeConversationId: "c-1",
        streamStatus: "idle",
        streamEvents: [],
        retained,
        retainedConversationId: "c-1",
      }),
    ).toBe(retained);
  });

  test("retained events are hidden after switching conversations", () => {
    const retained = [ev({ type: "tool.planned", seq: 1, callId: "c1", tool: "read" })];

    expect(
      visibleRunEventsForChat({
        activeRunId: null,
        activeConversationId: "c-2",
        streamStatus: "idle",
        streamEvents: [],
        retained,
        retainedConversationId: "c-1",
      }),
    ).toEqual([]);
  });
});
