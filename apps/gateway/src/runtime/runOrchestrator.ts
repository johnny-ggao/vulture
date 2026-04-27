import type { RunStore, PartialRunEvent } from "../domain/runStore";
import type { MessageStore } from "../domain/messageStore";
import type { ConversationStore } from "../domain/conversationStore";
import { runConversation, type LlmCallable, type ToolCallable } from "@vulture/agent-runtime";
import type { RunEvent } from "@vulture/protocol/src/v1/run";

export interface OrchestratorDeps {
  runs: RunStore;
  messages: MessageStore;
  conversations: ConversationStore;
  llm: LlmCallable;
  tools: ToolCallable;
  cancelSignals: Map<string, AbortController>;
}

export interface OrchestrateArgs {
  runId: string;
  agentId: string;
  model: string;
  systemPrompt: string;
  conversationId: string;
  userInput: string;
  workspacePath: string;
}

export async function orchestrateRun(deps: OrchestratorDeps, args: OrchestrateArgs): Promise<void> {
  const ac = new AbortController();
  let completedFinalText: string | null = null;
  deps.cancelSignals.set(args.runId, ac);
  try {
    deps.runs.markRunning(args.runId);
    const result = await runConversation({
      runId: args.runId,
      agentId: args.agentId,
      model: args.model,
      systemPrompt: args.systemPrompt,
      userInput: args.userInput,
      workspacePath: args.workspacePath,
      llm: deps.llm,
      tools: deps.tools,
      onEvent: (e: RunEvent) => {
        if (e.type === "run.completed") {
          completedFinalText = e.finalText;
          return;
        }
        deps.runs.appendEvent(args.runId, stripBase(e));
      },
    });

    if (result.status === "succeeded") {
      const assistantMsg = deps.messages.append({
        conversationId: args.conversationId,
        role: "assistant",
        content: result.finalText,
        runId: args.runId,
      });
      deps.runs.markSucceeded(args.runId, assistantMsg.id);
      deps.conversations.touch(args.conversationId);
      await maybeGenerateTitle(deps, args, result.finalText);
      deps.runs.appendEvent(args.runId, {
        type: "run.completed",
        resultMessageId: assistantMsg.id,
        finalText: completedFinalText ?? result.finalText,
      });
    } else {
      deps.runs.markFailed(args.runId, result.error!);
    }
  } finally {
    deps.cancelSignals.delete(args.runId);
  }
}

async function maybeGenerateTitle(
  deps: OrchestratorDeps,
  args: OrchestrateArgs,
  finalText: string,
): Promise<void> {
  const current = deps.conversations.get(args.conversationId);
  if (!current) return;
  const provisional = args.userInput.slice(0, 40);
  if (current.title !== provisional) return;
  if (isConfigurationFallback(finalText)) return;

  const title = await generateConversationTitle(deps.llm, args, finalText).catch(() => null);
  if (!title) return;
  deps.conversations.updateTitle(args.conversationId, title);
}

async function generateConversationTitle(
  llm: LlmCallable,
  args: OrchestrateArgs,
  finalText: string,
): Promise<string | null> {
  let text = "";
  const input = [
    "User message:",
    args.userInput,
    "",
    "Assistant response:",
    finalText.slice(0, 1200),
  ].join("\n");
  for await (const y of llm({
    runId: `${args.runId}:title`,
    model: args.model,
    systemPrompt:
      "Generate a concise conversation title. Return only the title, no quotes, no punctuation-only output, maximum 6 words.",
    userInput: input,
    workspacePath: args.workspacePath,
  })) {
    if (y.kind === "text.delta") text += y.text;
    if (y.kind === "final") text = y.text || text;
    if (y.kind === "tool.plan" || y.kind === "await.tool") return null;
  }
  return sanitizeTitle(text);
}

function sanitizeTitle(raw: string): string | null {
  const singleLine = raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!singleLine) return null;
  const compact = singleLine.replace(/\s+/g, " ").slice(0, 60).trim();
  return compact.length > 0 ? compact : null;
}

function isConfigurationFallback(text: string): boolean {
  return (
    text.includes("OPENAI_API_KEY not configured") ||
    text.includes("Codex 已过期")
  );
}

function stripBase(e: RunEvent): PartialRunEvent {
  const { runId: _r, seq: _s, createdAt: _c, ...rest } = e as RunEvent & {
    runId: string; seq: number; createdAt: string;
  };
  return rest as PartialRunEvent;
}
