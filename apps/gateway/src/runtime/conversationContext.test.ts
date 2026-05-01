import { describe, expect, test } from "bun:test";
import type { AgentInputItem } from "@openai/agents";
import type { Iso8601 } from "@vulture/protocol/src/v1/index";
import {
  buildConversationSessionInputCallback,
  estimateSessionTextChars,
  messageIdFromItem,
  shouldCompactConversation,
  textFromItem,
} from "./conversationContext";

function msg(role: "user" | "assistant", text: string, id = text): AgentInputItem {
  return {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    providerData: { messageId: id },
  } as AgentInputItem;
}

const now = "2026-04-28T00:00:00.000Z" as Iso8601;

describe("conversationContext", () => {
  test("injects summary, drops summarized raw items, keeps recent raw history, and appends new items", async () => {
    const callback = buildConversationSessionInputCallback({
      getContext: () => ({
        conversationId: "c-1",
        agentId: "a-1",
        summary: "Earlier: project code is alpha-17.",
        summarizedThroughMessageId: "m-2",
        inputItemCount: 8,
        inputCharCount: 800,
        createdAt: now,
        updatedAt: now,
      }),
      recentMessageLimit: 2,
    });

    const shaped = await callback(
      [
        msg("user", "old", "m-1"),
        msg("assistant", "old reply", "m-2"),
        msg("user", "recent 1", "m-3"),
        msg("assistant", "recent 2", "m-4"),
        msg("user", "trimmed after summary", "m-5"),
      ],
      [msg("user", "what is project code?", "m-6")],
    );

    const text = JSON.stringify(shaped);
    expect(shaped).toHaveLength(4);
    expect(text).toContain("Conversation context summary:");
    expect(text).toContain("<summary>");
    expect(text).toContain("Earlier: project code is alpha-17.");
    expect(text).toContain("</summary>");
    expect(text).toContain("recent turns are more specific");
    expect(text).not.toContain("old");
    expect(text).not.toContain("old reply");
    expect(text).not.toContain("recent 1");
    expect(text).toContain("recent 2");
    expect(text).toContain("trimmed after summary");
    expect(text).toContain("what is project code?");
    expect(text).not.toContain("providerData");
    expect(text).not.toContain("messageId");
    expect(text).not.toContain("message_id");
  });

  test("returns recent history plus new items without synthetic summary when no summary exists", async () => {
    const callback = buildConversationSessionInputCallback({
      getContext: () => null,
      recentMessageLimit: 1,
    });

    const shaped = await callback(
      [msg("user", "old", "m-1"), msg("assistant", "recent", "m-2")],
      [msg("user", "new", "m-3")],
    );

    expect(shaped).toEqual([
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: "recent" }],
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "new" }],
      },
    ]);
    expect(JSON.stringify(shaped)).not.toContain("Conversation context summary:");
  });

  test("strips local provider metadata before returning session input to the SDK", async () => {
    const callback = buildConversationSessionInputCallback({
      getContext: () => null,
      recentMessageLimit: 6,
    });

    const shaped = await callback(
      [
        {
          type: "message",
          role: "user",
          providerData: { messageId: "m-1", message_id: "m-1" },
          content: [{ type: "input_text", text: "old" }],
        } as unknown as AgentInputItem,
      ],
      [
        {
          type: "message",
          role: "user",
          providerData: { messageId: "m-2", item_id: "m-2" },
          content: [{ type: "input_text", text: "new" }],
        } as unknown as AgentInputItem,
      ],
    );

    expect(JSON.stringify(shaped)).toBe(
      JSON.stringify([
        { type: "message", role: "user", content: [{ type: "input_text", text: "old" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: "new" }] },
      ]),
    );
  });

  test("normalizes legacy assistant messages so SDK run state can serialize", async () => {
    const callback = buildConversationSessionInputCallback({ getContext: () => null });

    const shaped = await callback([msg("assistant", "legacy assistant", "m-1")], []);

    expect(shaped[0]).toMatchObject({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "legacy assistant" }],
    });
  });

  test("keeps recent tail when summarizedThroughMessageId is missing", async () => {
    const callback = buildConversationSessionInputCallback({
      getContext: () => ({
        conversationId: "c-1",
        agentId: "a-1",
        summary: "Earlier context",
        summarizedThroughMessageId: null,
        inputItemCount: 10,
        inputCharCount: 300,
        createdAt: now,
        updatedAt: now,
      }),
      recentMessageLimit: 2,
    });

    const shaped = await callback(
      [msg("user", "old", "m-1"), msg("assistant", "tail 1", "m-2"), msg("user", "tail 2", "m-3")],
      [msg("user", "new", "m-4")],
    );

    const text = JSON.stringify(shaped);
    expect(text).toContain("Earlier context");
    expect(text).not.toContain("old");
    expect(text).toContain("tail 1");
    expect(text).toContain("tail 2");
    expect(text).toContain("new");
  });

  test("uses the last matching summarizedThroughMessageId as the cutoff", async () => {
    const callback = buildConversationSessionInputCallback({
      getContext: () => ({
        conversationId: "c-1",
        agentId: "a-1",
        summary: "Earlier context",
        summarizedThroughMessageId: "duplicate-id",
        inputItemCount: 10,
        inputCharCount: 300,
        createdAt: now,
        updatedAt: now,
      }),
      recentMessageLimit: 10,
    });

    const shaped = await callback(
      [
        msg("user", "first duplicate", "duplicate-id"),
        msg("assistant", "between duplicates", "m-2"),
        msg("user", "last duplicate", "duplicate-id"),
        msg("assistant", "after duplicate", "m-4"),
      ],
      [msg("user", "new", "m-5")],
    );

    const text = JSON.stringify(shaped);
    expect(text).not.toContain("between duplicates");
    expect(text).not.toContain("last duplicate");
    expect(text).toContain("after duplicate");
    expect(text).toContain("new");
  });

  test("falls back to recent history plus new items when context lookup fails", async () => {
    const callback = buildConversationSessionInputCallback({
      getContext: () => {
        throw new Error("db unavailable");
      },
      recentMessageLimit: 1,
    });

    const shaped = await callback([msg("user", "older"), msg("assistant", "recent")], [msg("user", "new")]);

    expect(JSON.stringify(shaped)).toContain("recent");
    expect(JSON.stringify(shaped)).toContain("new");
    expect(JSON.stringify(shaped)).not.toContain("older");
    expect(JSON.stringify(shaped)).not.toContain("Conversation context summary:");
  });

  test("estimates chars and triggers compaction by count or character threshold", () => {
    const items = Array.from({ length: 13 }, (_, index) => msg("user", `message ${index}`));

    expect(estimateSessionTextChars(items)).toBeGreaterThan(50);
    expect(shouldCompactConversation({ items, maxRawMessages: 12, maxRawChars: 24_000 })).toBe(true);
    expect(shouldCompactConversation({ items: [msg("user", "short")], maxRawMessages: 12, maxRawChars: 3 })).toBe(true);
    expect(shouldCompactConversation({ items: [msg("user", "short")], maxRawMessages: 12, maxRawChars: 24_000 })).toBe(false);
  });

  test("triggers compaction at exact count and character thresholds", () => {
    const defaultCountThresholdItems = Array.from({ length: 12 }, (_, index) => msg("user", `m${index}`));
    const exactCharThresholdItems = [msg("user", "abc"), msg("assistant", "de")];

    expect(shouldCompactConversation({ items: defaultCountThresholdItems })).toBe(true);
    expect(shouldCompactConversation({ items: exactCharThresholdItems, maxRawMessages: 10, maxRawChars: 5 })).toBe(true);
    expect(shouldCompactConversation({ items: [msg("user", "abcd")], maxRawMessages: 10, maxRawChars: 5 })).toBe(false);
  });

  test("extracts text and message ids conservatively from SDK items", () => {
    const item = msg("assistant", "hello", "m-1");
    const nestedProviderDataItem = {
      ...msg("user", "nested", "unused"),
      item: { providerData: { messageId: "nested-m-1" } },
      providerData: undefined,
    } as unknown as AgentInputItem;
    const toolResult = {
      type: "function_call_result",
      name: "shell_exec",
      callId: "call-1",
      status: "completed",
      output: "done",
    } satisfies AgentInputItem;
    const topLevelIdItem = {
      type: "unknown",
      id: "top-level-id",
    } satisfies AgentInputItem;
    const rawItemIdItem = {
      type: "unknown",
      rawItem: { id: "raw-item-id" },
    } as unknown as AgentInputItem;
    const providerMessageSnakeIdItem = {
      type: "unknown",
      providerData: { message_id: "provider-message-snake-id" },
    } satisfies AgentInputItem;
    const providerItemIdItem = {
      type: "unknown",
      providerData: { itemId: "provider-item-id" },
    } satisfies AgentInputItem;
    const providerSnakeItemIdItem = {
      type: "unknown",
      providerData: { item_id: "provider-snake-item-id" },
    } satisfies AgentInputItem;
    const providerIdItem = {
      type: "unknown",
      providerData: { id: "provider-id" },
    } satisfies AgentInputItem;

    expect(textFromItem(item)).toBe("hello");
    expect(textFromItem(toolResult)).toBe("done");
    expect(textFromItem("plain text" as unknown as AgentInputItem)).toBe("plain text");
    expect(messageIdFromItem(item)).toBe("m-1");
    expect(messageIdFromItem(nestedProviderDataItem)).toBe("nested-m-1");
    expect(messageIdFromItem(topLevelIdItem)).toBe("top-level-id");
    expect(messageIdFromItem(rawItemIdItem)).toBe("raw-item-id");
    expect(messageIdFromItem(providerMessageSnakeIdItem)).toBe("provider-message-snake-id");
    expect(messageIdFromItem(providerItemIdItem)).toBe("provider-item-id");
    expect(messageIdFromItem(providerSnakeItemIdItem)).toBe("provider-snake-item-id");
    expect(messageIdFromItem(providerIdItem)).toBe("provider-id");
    expect(messageIdFromItem({ type: "message", role: "user", content: [] } as AgentInputItem)).toBeNull();
  });

  test("recursively extracts visible text from structured outputs and ignores binary-like payloads", () => {
    const structuredOutput = {
      type: "function_call_result",
      name: "tool",
      callId: "call-1",
      status: "completed",
      output: { type: "text", text: "structured text" },
    } as unknown as AgentInputItem;
    const arrayOutput = {
      type: "function_call_result",
      name: "tool",
      callId: "call-2",
      status: "completed",
      output: [
        { type: "text", text: "first" },
        { output: { type: "text", text: "second" } },
      ],
    } as unknown as AgentInputItem;
    const imagePayload = {
      type: "message",
      role: "user",
      content: [
        { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        { type: "input_file", file_id: "file-1", bytes: "AAAA" },
      ],
    } as unknown as AgentInputItem;

    expect(textFromItem(structuredOutput)).toBe("structured text");
    expect(textFromItem(arrayOutput)).toBe("first\nsecond");
    expect(textFromItem(imagePayload)).toBe("");
  });
});
