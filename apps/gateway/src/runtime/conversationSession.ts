import type { AgentInputItem, Session } from "@openai/agents";
import type { ConversationContextStore } from "../domain/conversationContextStore";

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
    this.store.addSessionItems(
      this.conversationId,
      items.map((item) => ({
        messageId: null,
        role: roleFromItem(item),
        item,
      })),
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
