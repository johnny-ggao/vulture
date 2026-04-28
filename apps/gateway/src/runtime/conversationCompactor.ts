import type { AgentInputItem } from "@openai/agents";
import type { LlmCallable } from "@vulture/agent-runtime";
import type { UpsertConversationContextInput } from "../domain/conversationContextStore";
import { estimateSessionTextChars, messageIdFromItem, textFromItem } from "./conversationContext";

const DEFAULT_RECENT_MESSAGE_LIMIT = 6;
const MAX_SUMMARY_CHARS = 2000;

export interface CompactConversationContextInput {
  conversationId: string;
  agentId: string;
  model: string;
  workspacePath: string;
  items: readonly AgentInputItem[];
  recentMessageLimit?: number;
  existingSummary?: string | null;
  llm: LlmCallable;
  upsertContext: (input: UpsertConversationContextInput) => void | Promise<void>;
}

export async function compactConversationContext(input: CompactConversationContextInput): Promise<void> {
  const recentLimit = input.recentMessageLimit ?? DEFAULT_RECENT_MESSAGE_LIMIT;
  const olderItems = input.items.slice(0, Math.max(0, input.items.length - recentLimit));
  if (olderItems.length === 0) return;

  let accumulated = "";
  let finalText: string | null = null;
  try {
    for await (const event of input.llm({
      systemPrompt: [
        "Summarize older part of conversation for future turns.",
        "Preserve stable goals, constraints, preferences, decisions, pending tasks, and important results.",
        "No generic pleasantries.",
        "Do not invent facts.",
        "Return concise Markdown max 2000 chars.",
      ].join("\n"),
      userInput: [
        `Existing summary:\n${input.existingSummary?.trim() || "(none)"}`,
        `Older messages:\n${olderItems.map(formatOlderItem).join("\n\n")}`,
      ].join("\n\n"),
      model: input.model,
      runId: `context-compaction-${input.conversationId}`,
      workspacePath: input.workspacePath,
    })) {
      if (event.kind === "tool.plan" || event.kind === "await.tool") return;
      if (event.kind === "text.delta") accumulated += event.text;
      if (event.kind === "final") finalText = event.text;
    }
  } catch {
    return;
  }

  const rawSummary = finalText?.trim() ? finalText : accumulated;
  const summary = rawSummary.trim().slice(0, MAX_SUMMARY_CHARS);
  if (!summary) return;

  const cutoffItem = olderItems[olderItems.length - 1];
  const cutoffMessageId = messageIdFromItem(cutoffItem);
  if (!cutoffMessageId) return;

  await input.upsertContext({
    conversationId: input.conversationId,
    agentId: input.agentId,
    summary,
    summarizedThroughMessageId: cutoffMessageId,
    inputItemCount: input.items.length,
    inputCharCount: estimateSessionTextChars(input.items),
  });
}

function formatOlderItem(item: AgentInputItem): string {
  return `[${roleFromItem(item)}] ${textFromItem(item)}`;
}

function roleFromItem(item: AgentInputItem): string {
  if (!isRecord(item)) return "item";
  const record = item as Record<string, unknown>;
  return typeof record.role === "string" && record.role.length > 0 ? record.role : "item";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
