import { describe, expect, mock, test } from "bun:test";
import type { AgentInputItem } from "@openai/agents";
import type { AddSessionItemInput, ConversationContextStore } from "../domain/conversationContextStore";
import { VultureConversationSession } from "./conversationSession";

describe("VultureConversationSession", () => {
  test("delegates SDK Session methods to ConversationContextStore", async () => {
    const items: AgentInputItem[] = [];
    const store = {
      listSessionItems: mock((_conversationId: string, limit?: number) => {
        const selected = limit === undefined ? items : items.slice(-limit);
        return selected.map((item, index) => ({ id: `i-${index}`, item }));
      }),
      addSessionItems: mock((_conversationId: string, added: AddSessionItemInput[]) => {
        items.push(...added.map((entry) => entry.item));
      }),
      popSessionItem: mock(() => {
        const item = items.pop();
        return item ? { item } : undefined;
      }),
      clearSession: mock(() => {
        items.length = 0;
      }),
    } as unknown as ConversationContextStore;

    const session = new VultureConversationSession(store, "c-1");
    const userItem = {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    } satisfies AgentInputItem;
    const unknownRoleItem = {
      type: "function_call_result",
      name: "shell_exec",
      callId: "call-1",
      status: "completed",
      output: "done",
    } satisfies AgentInputItem;

    expect(await session.getSessionId()).toBe("c-1");

    await session.addItems([userItem, unknownRoleItem]);

    expect(await session.getItems()).toEqual([userItem, unknownRoleItem]);
    expect(await session.getItems(1)).toEqual([unknownRoleItem]);
    expect(await session.popItem()).toEqual(unknownRoleItem);
    await session.clearSession();

    expect(store.listSessionItems).toHaveBeenLastCalledWith("c-1", 1);
    expect(store.popSessionItem).toHaveBeenCalledWith("c-1");
    expect(store.clearSession).toHaveBeenCalledWith("c-1");
    expect(store.addSessionItems).toHaveBeenCalledWith("c-1", [
      { messageId: null, role: "user", item: userItem },
      { messageId: null, role: "unknown", item: unknownRoleItem },
    ]);
  });
});
