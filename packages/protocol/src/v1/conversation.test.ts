import { describe, expect, test } from "bun:test";
import {
  ConversationSchema,
  MessageSchema,
  CreateConversationRequestSchema,
  PostMessageRequestSchema,
  type Conversation,
  type Message,
} from "./conversation";

describe("Conversation + Message schemas", () => {
  const conv: Conversation = {
    id: "c-01" as Conversation["id"],
    agentId: "local-work-agent" as Conversation["agentId"],
    title: "Hello",
    permissionMode: "full_access",
    createdAt: "2026-04-26T00:00:00.000Z" as Conversation["createdAt"],
    updatedAt: "2026-04-26T00:00:00.000Z" as Conversation["updatedAt"],
  };
  const msg: Message = {
    id: "m-01" as Message["id"],
    conversationId: conv.id,
    role: "user",
    content: "Hi",
    runId: null,
    createdAt: "2026-04-26T00:00:00.000Z" as Message["createdAt"],
    attachments: [],
  };

  test("ConversationSchema parses sample", () => {
    expect(ConversationSchema.parse(conv)).toEqual(conv);
  });

  test("MessageSchema accepts user/assistant/system roles", () => {
    expect(MessageSchema.parse(msg).role).toBe("user");
    expect(MessageSchema.parse({ ...msg, role: "assistant" }).role).toBe("assistant");
    expect(MessageSchema.parse({ ...msg, role: "system" }).role).toBe("system");
  });

  test("MessageSchema accepts persisted attachments", () => {
    const parsed = MessageSchema.parse({
      ...msg,
      attachments: [
        {
          id: "att-01",
          blobId: "blob-01",
          kind: "image",
          displayName: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 123,
          contentUrl: "/v1/attachments/att-01/content",
          createdAt: "2026-04-26T00:00:00.000Z",
        },
      ],
    });

    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].kind).toBe("image");
  });

  test("MessageSchema rejects 'tool' role", () => {
    expect(() => MessageSchema.parse({ ...msg, role: "tool" })).toThrow();
  });

  test("CreateConversationRequest: only agentId required", () => {
    const r = CreateConversationRequestSchema.parse({ agentId: "x" });
    expect(r.agentId).toBe("x");
    expect(r.title).toBeUndefined();
    expect(r.permissionMode).toBe("full_access");
  });

  test("CreateConversationRequest accepts policy permission mode", () => {
    const r = CreateConversationRequestSchema.parse({
      agentId: "x",
      permissionMode: "policy",
    });
    expect(r.permissionMode).toBe("policy");
  });

  test("PostMessageRequest requires non-empty input", () => {
    expect(PostMessageRequestSchema.parse({ input: "hi" }).input).toBe("hi");
    expect(() => PostMessageRequestSchema.parse({ input: "" })).toThrow();
  });

  test("PostMessageRequest accepts up to 10 attachment ids", () => {
    const attachmentIds = Array.from({ length: 10 }, (_, i) => `att-${i}`);
    expect(PostMessageRequestSchema.parse({ input: "hi", attachmentIds }).attachmentIds).toEqual(
      attachmentIds,
    );
    expect(() =>
      PostMessageRequestSchema.parse({
        input: "hi",
        attachmentIds: Array.from({ length: 11 }, (_, i) => `att-${i}`),
      }),
    ).toThrow();
  });
});
