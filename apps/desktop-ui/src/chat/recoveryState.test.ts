import { beforeEach, describe, expect, test } from "bun:test";
import {
  clearActiveRunId,
  clearRunLastSeq,
  readActiveChatState,
  readRunLastSeq,
  writeActiveChatState,
  writeRunLastSeq,
} from "./recoveryState";

describe("chat recovery state", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("persists active conversation and run ids", () => {
    writeActiveChatState({ conversationId: "c-1", runId: "r-1" });

    expect(readActiveChatState()).toEqual({ conversationId: "c-1", runId: "r-1" });
  });

  test("clearActiveRunId preserves active conversation", () => {
    writeActiveChatState({ conversationId: "c-1", runId: "r-1" });

    clearActiveRunId();

    expect(readActiveChatState()).toEqual({ conversationId: "c-1", runId: null });
  });

  test("persists last seen seq per run", () => {
    writeRunLastSeq("r-1", 7);
    writeRunLastSeq("r-2", 3);

    expect(readRunLastSeq("r-1")).toBe(7);
    expect(readRunLastSeq("r-2")).toBe(3);

    clearRunLastSeq("r-1");
    expect(readRunLastSeq("r-1")).toBe(-1);
    expect(readRunLastSeq("r-2")).toBe(3);
  });
});
