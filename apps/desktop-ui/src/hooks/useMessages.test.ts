import { describe, expect, test } from "bun:test";
import { messagesReducer, type MessagesState } from "./useMessages";
import type { MessageDto } from "../api/conversations";

const m1: MessageDto = {
  id: "m-1",
  conversationId: "c-1",
  role: "user",
  content: "hi",
  runId: null,
  createdAt: "2026-04-27T00:00:00.000Z",
};
const m2: MessageDto = { ...m1, id: "m-2", role: "assistant", content: "yo" };

const initial: MessagesState = { items: [], loading: false, error: null };

describe("messagesReducer", () => {
  test("load.success replaces items", () => {
    const s = messagesReducer(initial, { type: "load.success", items: [m1, m2] });
    expect(s.items).toEqual([m1, m2]);
  });

  test("append adds without duplicating", () => {
    const s1 = messagesReducer({ ...initial, items: [m1] }, { type: "append", item: m2 });
    expect(s1.items).toEqual([m1, m2]);
    const s2 = messagesReducer(s1, { type: "append", item: m2 });
    expect(s2.items).toEqual([m1, m2]);
  });

  test("clear empties items", () => {
    const s = messagesReducer({ ...initial, items: [m1, m2] }, { type: "clear" });
    expect(s.items).toEqual([]);
  });
});
