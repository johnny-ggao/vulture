import { describe, expect, test } from "bun:test";
import {
  conversationsReducer,
  type ConversationsState,
} from "./useConversations";
import type { ConversationDto } from "../api/conversations";

const a: ConversationDto = {
  id: "c-a",
  agentId: "agent",
  title: "A",
  createdAt: "2026-04-27T00:00:00.000Z",
  updatedAt: "2026-04-27T00:00:00.000Z",
};
const b: ConversationDto = { ...a, id: "c-b", title: "B" };

const initial: ConversationsState = { items: [], loading: false, error: null };

describe("conversationsReducer", () => {
  test("loading -> success replaces items", () => {
    const s1 = conversationsReducer(initial, { type: "load.start" });
    expect(s1.loading).toBe(true);
    const s2 = conversationsReducer(s1, { type: "load.success", items: [a, b] });
    expect(s2.items).toEqual([a, b]);
    expect(s2.loading).toBe(false);
  });

  test("create.optimistic prepends item", () => {
    const s = conversationsReducer({ ...initial, items: [a] }, { type: "create.optimistic", item: b });
    expect(s.items.map((x) => x.id)).toEqual(["c-b", "c-a"]);
  });

  test("create.commit replaces optimistic by id", () => {
    const optimistic: ConversationDto = { ...b, title: "(temp)" };
    const real: ConversationDto = { ...b, title: "(real)" };
    const s1 = conversationsReducer(initial, { type: "create.optimistic", item: optimistic });
    const s2 = conversationsReducer(s1, { type: "create.commit", id: optimistic.id, item: real });
    expect(s2.items).toEqual([real]);
  });

  test("delete removes by id", () => {
    const s = conversationsReducer({ ...initial, items: [a, b] }, { type: "delete", id: a.id });
    expect(s.items).toEqual([b]);
  });

  test("load.error sets error", () => {
    const s = conversationsReducer(initial, { type: "load.error", error: "boom" });
    expect(s.error).toBe("boom");
    expect(s.loading).toBe(false);
  });
});
