import type { AgentInputItem, SessionInputCallback } from "@openai/agents";
import type { ConversationContext } from "../domain/conversationContextStore";

const DEFAULT_RECENT_MESSAGE_LIMIT = 6;
const DEFAULT_MAX_RAW_MESSAGES = 12;
const DEFAULT_MAX_RAW_CHARS = 24_000;

export interface BuildConversationSessionInputCallbackOptions {
  getContext: () => ConversationContext | null | Promise<ConversationContext | null>;
  recentMessageLimit?: number;
}

export function buildConversationSessionInputCallback(
  opts: BuildConversationSessionInputCallbackOptions,
): SessionInputCallback {
  const recentLimit = opts.recentMessageLimit ?? DEFAULT_RECENT_MESSAGE_LIMIT;

  return async (historyItems, newItems) => {
    let context: ConversationContext | null = null;
    try {
      context = await opts.getContext();
    } catch {
      context = null;
    }

    const rawHistory = rawHistoryAfterSummary(
      historyItems,
      context?.summary.trim() ? context.summarizedThroughMessageId : null,
    ).slice(-recentLimit);
    const summaryPrefix = context?.summary.trim() ? [summaryItem(context.summary)] : [];

    return stripLocalProviderMetadataFromItems([...summaryPrefix, ...rawHistory, ...newItems]);
  };
}

export function shouldCompactConversation(input: {
  items: readonly AgentInputItem[];
  maxRawMessages?: number;
  maxRawChars?: number;
}): boolean {
  const maxRawMessages = input.maxRawMessages ?? DEFAULT_MAX_RAW_MESSAGES;
  const maxRawChars = input.maxRawChars ?? DEFAULT_MAX_RAW_CHARS;

  return input.items.length >= maxRawMessages || estimateSessionTextChars(input.items) >= maxRawChars;
}

export function estimateSessionTextChars(items: readonly AgentInputItem[]): number {
  return items.reduce((sum, item) => sum + textFromItem(item).length, 0);
}

export function textFromItem(item: AgentInputItem): string {
  if (typeof item === "string") return item;
  if (!isRecord(item)) return "";

  const record = item as Record<string, unknown>;
  return joinText([textFromValue(record.content), textFromValue(record.output)]);
}

function textFromValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return joinText(value.map((item) => textFromValue(item)));
  if (!isRecord(value)) return "";

  const type = typeof value.type === "string" ? value.type : "";
  if (isBinaryLikeType(type) && !("text" in value) && !("output" in value)) return "";
  return joinText([stringField(value, "text"), textFromValue(value.output)]);
}

function joinText(parts: Array<string | null | undefined>): string {
  return parts.filter((part): part is string => typeof part === "string" && part.length > 0).join("\n");
}

function isBinaryLikeType(type: string): boolean {
  return type.includes("image") || type.includes("file") || type.includes("audio") || type.includes("video");
}

export function messageIdFromItem(item: AgentInputItem): string | null {
  if (!isRecord(item)) return null;

  const topLevelId = stringField(item, "id");
  if (topLevelId) return topLevelId;

  for (const providerData of providerDataCandidates(item)) {
    const messageId =
      stringField(providerData, "messageId") ??
      stringField(providerData, "message_id") ??
      stringField(providerData, "itemId") ??
      stringField(providerData, "item_id") ??
      stringField(providerData, "id");
    if (messageId) return messageId;
  }

  const rawItemId = rawItemIdFromItem(item);
  if (rawItemId) return rawItemId;

  return null;
}

function rawHistoryAfterSummary(
  items: readonly AgentInputItem[],
  summarizedThroughMessageId?: string | null,
): AgentInputItem[] {
  if (!summarizedThroughMessageId) return [...items];

  let index = -1;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (messageIdFromItem(items[i]) === summarizedThroughMessageId) {
      index = i;
      break;
    }
  }
  return index >= 0 ? items.slice(index + 1) : [...items];
}

function summaryItem(summary: string): AgentInputItem {
  return {
    type: "message",
    role: "user",
    content: [
      {
        type: "input_text",
        text: [
          "Conversation context summary:",
          "<summary>",
          summary.trim(),
          "</summary>",
          "",
          "The recent turns are more specific than this summary when they conflict.",
        ].join("\n"),
      },
    ],
  } as AgentInputItem;
}

function stripLocalProviderMetadataFromItems(items: readonly AgentInputItem[]): AgentInputItem[] {
  return items.map((item) => stripLocalProviderMetadata(item) as AgentInputItem);
}

function stripLocalProviderMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripLocalProviderMetadata(item));
  }
  if (!isRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "providerData" || key === "provider_data" || key === "messageId" || key === "message_id") {
      continue;
    }
    result[key] = stripLocalProviderMetadata(entry);
  }
  if (
    result.type === "message" &&
    result.role === "assistant" &&
    result.status === undefined
  ) {
    result.status = "completed";
  }
  return result;
}

function providerDataCandidates(item: Record<string, unknown>): Record<string, unknown>[] {
  const candidates: Record<string, unknown>[] = [];
  addRecordCandidate(candidates, item.providerData);

  for (const key of ["item", "rawItem", "raw_item", "sourceItem"]) {
    const nested = item[key];
    if (isRecord(nested)) addRecordCandidate(candidates, nested.providerData);
  }

  return candidates;
}

function rawItemIdFromItem(item: Record<string, unknown>): string | null {
  const rawItem = item.rawItem;
  return isRecord(rawItem) ? stringField(rawItem, "id") : null;
}

function addRecordCandidate(candidates: Record<string, unknown>[], value: unknown): void {
  if (isRecord(value)) candidates.push(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
