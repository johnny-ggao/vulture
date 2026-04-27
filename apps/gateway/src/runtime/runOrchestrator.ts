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
      onEvent: (e: RunEvent) => deps.runs.appendEvent(args.runId, stripBase(e)),
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
    } else {
      deps.runs.markFailed(args.runId, result.error!);
    }
  } finally {
    deps.cancelSignals.delete(args.runId);
  }
}

function stripBase(e: RunEvent): PartialRunEvent {
  const { runId: _r, seq: _s, createdAt: _c, ...rest } = e as RunEvent & {
    runId: string; seq: number; createdAt: string;
  };
  return rest as PartialRunEvent;
}
