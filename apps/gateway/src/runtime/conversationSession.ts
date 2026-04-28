import type { AgentInputItem, Session } from "@openai/agents";
import type { ConversationContextStore } from "../domain/conversationContextStore";
import { messageIdFromItem, textFromItem } from "./conversationContext";

export class VultureConversationSession implements Session {
  constructor(
    private readonly store: ConversationContextStore,
    private readonly conversationId: string,
  ) {}

  async getSessionId(): Promise<string> {
    return this.conversationId;
  }

  async getItems(limit?: number): Promise<AgentInputItem[]> {
    return this.store
      .listSessionItems(this.conversationId, limit)
      .map((item) => item.item);
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    const sessionItems = items.flatMap((item) => {
      const role = roleFromItem(item);
      if (role !== "user" && role !== "assistant") return [];
      const text = textFromItem(item).trim();
      if (!text) return [];
      return [{
        messageId: messageIdFromItem(item),
        role,
        item: textMessageSessionItem(role, text, messageIdFromItem(item)),
      }];
    });
    if (sessionItems.length === 0) return;

    this.store.addSessionItems(
      this.conversationId,
      sessionItems,
    );
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    return this.store.popSessionItem(this.conversationId)?.item;
  }

  async clearSession(): Promise<void> {
    this.store.clearSession(this.conversationId);
  }
}

function roleFromItem(item: AgentInputItem): string {
  if (typeof item === "object" && item !== null && "role" in item && typeof item.role === "string") {
    return item.role;
  }
  return "unknown";
}

function textMessageSessionItem(
  role: "user" | "assistant",
  text: string,
  messageId: string | null,
): AgentInputItem {
  return {
    type: "message",
    role,
    ...(messageId ? { providerData: { messageId } } : {}),
    content: [
      {
        type: role === "user" ? "input_text" : "output_text",
        text,
      },
    ],
  } as AgentInputItem;
}
