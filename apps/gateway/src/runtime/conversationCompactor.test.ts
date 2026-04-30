import { describe, expect, mock, test } from "bun:test";
import type { AgentInputItem } from "@openai/agents";
import type { LlmCallable, LlmYield } from "@vulture/agent-runtime";
import { estimateSessionTextChars } from "./conversationContext";
import { compactConversationContext } from "./conversationCompactor";
import { createRuntimeHookRunner } from "./runtimeHooks";

function msg(role: "user" | "assistant", text: string, id: string): AgentInputItem {
  return {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    providerData: { messageId: id },
  } as AgentInputItem;
}

function baseInput(overrides: Partial<Parameters<typeof compactConversationContext>[0]> = {}) {
  const items = [
    msg("user", "old user one", "m-1"),
    msg("assistant", "old assistant one", "m-2"),
    msg("user", "old user two", "m-3"),
    msg("assistant", "recent assistant", "m-4"),
    msg("user", "recent user", "m-5"),
  ];
  const upserts: Array<Parameters<Parameters<typeof compactConversationContext>[0]["upsertContext"]>[0]> = [];
  const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
    yield { kind: "final", text: "Summary from model" };
  });

  return {
    input: {
      conversationId: "c-1",
      agentId: "a-1",
      model: "gpt-5.4",
      workspacePath: "/tmp/workspace",
      items,
      recentMessageLimit: 2,
      existingSummary: "Earlier summary",
      llm,
      upsertContext: (context) => {
        upserts.push(context);
      },
      ...overrides,
    } satisfies Parameters<typeof compactConversationContext>[0],
    items,
    llm,
    upserts,
  };
}

describe("compactConversationContext", () => {
  test("summarizes older items and updates through cutoff message", async () => {
    const llmInputs: Parameters<LlmCallable>[0][] = [];
    const llm: LlmCallable = mock(async function* (
      input: Parameters<LlmCallable>[0],
    ): AsyncGenerator<LlmYield, void, unknown> {
      llmInputs.push(input);
      yield { kind: "text.delta", text: "Delta " };
      yield { kind: "final", text: "Stable summary" };
    });
    const { input, items, upserts } = baseInput({ llm });

    await compactConversationContext(input);

    expect(llm).toHaveBeenCalledTimes(1);
    const llmInput = llmInputs[0];
    expect(llmInput?.systemPrompt).toContain("Summarize older part of conversation");
    expect(llmInput?.systemPrompt).toContain("No generic pleasantries");
    expect(llmInput?.systemPrompt).toContain("Do not invent facts");
    expect(llmInput?.systemPrompt).toContain("max 2000 chars");
    expect(llmInput?.userInput).toContain("Existing summary:\nEarlier summary");
    expect(llmInput?.userInput).toContain("[user] old user one");
    expect(llmInput?.userInput).toContain("[assistant] old assistant one");
    expect(llmInput?.userInput).toContain("[user] old user two");
    expect(llmInput?.userInput).not.toContain("recent assistant");
    expect(llmInput?.userInput).not.toContain("recent user");
    expect(upserts).toEqual([{
      conversationId: "c-1",
      agentId: "a-1",
      summary: "Stable summary",
      summarizedThroughMessageId: "m-3",
      inputItemCount: items.length,
      inputCharCount: estimateSessionTextChars(items),
    }]);
  });

  test("does not update when summarization fails", async () => {
    const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
      throw new Error("model unavailable");
    });
    const { input, upserts } = baseInput({ llm });

    await compactConversationContext(input);

    expect(upserts).toEqual([]);
  });

  test("does not update if tool event appears", async () => {
    for (const toolEvent of [
      { kind: "tool.plan", callId: "call-1", tool: "shell", input: {} },
      { kind: "await.tool", callId: "call-1" },
    ] satisfies LlmYield[]) {
      const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
        yield { kind: "text.delta", text: "partial" };
        yield toolEvent;
        yield { kind: "final", text: "should not persist" };
      });
      const { input, upserts } = baseInput({ llm });

      await compactConversationContext(input);

      expect(upserts).toEqual([]);
    }
  });

  test("truncates summary to 2000 chars", async () => {
    const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
      yield { kind: "final", text: "x".repeat(2100) };
    });
    const { input, upserts } = baseInput({ llm });

    await compactConversationContext(input);

    expect(upserts[0]?.summary).toHaveLength(2000);
    expect(upserts[0]?.summary).toBe("x".repeat(2000));
  });

  test("does nothing when item count is at or below recentMessageLimit", async () => {
    const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
      yield { kind: "final", text: "unused" };
    });
    const upsertContext = mock(() => {});

    await compactConversationContext({
      conversationId: "c-1",
      agentId: "a-1",
      model: "gpt-5.4",
      workspacePath: "/tmp/workspace",
      items: [msg("user", "one", "m-1"), msg("assistant", "two", "m-2")],
      recentMessageLimit: 2,
      existingSummary: null,
      llm,
      upsertContext,
    });

    expect(llm).not.toHaveBeenCalled();
    expect(upsertContext).not.toHaveBeenCalled();
  });

  test("uses default recentMessageLimit of 6 when omitted", async () => {
    const items = Array.from({ length: 7 }, (_, index) => msg("user", `message ${index + 1}`, `m-${index + 1}`));
    const upserts: Array<Parameters<Parameters<typeof compactConversationContext>[0]["upsertContext"]>[0]> = [];
    const llmInputs: Parameters<LlmCallable>[0][] = [];
    const llm: LlmCallable = mock(async function* (
      input: Parameters<LlmCallable>[0],
    ): AsyncGenerator<LlmYield, void, unknown> {
      llmInputs.push(input);
      yield { kind: "final", text: "Only first message summarized" };
    });

    await compactConversationContext({
      conversationId: "c-1",
      agentId: "a-1",
      model: "gpt-5.4",
      workspacePath: "/tmp/workspace",
      items,
      existingSummary: null,
      llm,
      upsertContext: (context) => {
        upserts.push(context);
      },
    });

    expect(llmInputs[0]?.userInput).toContain("[user] message 1");
    expect(llmInputs[0]?.userInput).not.toContain("[user] message 2");
    expect(upserts).toEqual([{
      conversationId: "c-1",
      agentId: "a-1",
      summary: "Only first message summarized",
      summarizedThroughMessageId: "m-1",
      inputItemCount: 7,
      inputCharCount: estimateSessionTextChars(items),
    }]);
  });

  test("does not update for empty or whitespace-only model summaries", async () => {
    for (const finalText of ["", "   \n\t  "]) {
      const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
        yield { kind: "final", text: finalText };
      });
      const { input, upserts } = baseInput({ llm });

      await compactConversationContext(input);

      expect(upserts).toEqual([]);
    }
  });

  test("does not update when cutoff item has no recoverable message id", async () => {
    const idlessCutoffItem = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "old assistant without id" }],
    } as AgentInputItem;
    const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
      yield { kind: "final", text: "Summary that cannot be safely anchored" };
    });
    const { input, upserts } = baseInput({
      llm,
      items: [
        msg("user", "old user one", "m-1"),
        idlessCutoffItem,
        msg("user", "recent user", "m-3"),
      ],
      recentMessageLimit: 1,
    });

    await compactConversationContext(input);

    expect(upserts).toEqual([]);
  });

  test("emits context.beforeCompact / context.afterCompact around the work", async () => {
    const phases: string[] = [];
    const runtimeHooks = createRuntimeHookRunner([
      {
        name: "context.beforeCompact",
        handler: () => {
          phases.push("before");
        },
      },
      {
        name: "context.afterCompact",
        handler: () => {
          phases.push("after");
        },
      },
    ]);

    const { input } = baseInput({ runtimeHooks, runId: "r-compact" });
    await compactConversationContext(input);

    expect(phases).toEqual(["before", "after"]);
  });

  test("emits afterCompact even when summarization fails", async () => {
    const phases: string[] = [];
    const runtimeHooks = createRuntimeHookRunner([
      {
        name: "context.beforeCompact",
        handler: () => {
          phases.push("before");
        },
      },
      {
        name: "context.afterCompact",
        handler: () => {
          phases.push("after");
        },
      },
    ]);
    const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
      throw new Error("model unavailable");
    });
    const { input, upserts } = baseInput({ llm, runtimeHooks, runId: "r-fail" });

    await compactConversationContext(input);

    expect(upserts).toEqual([]);
    expect(phases).toEqual(["before", "after"]);
  });

  test("does not emit hooks when there are no older items to compact", async () => {
    const phases: string[] = [];
    const runtimeHooks = createRuntimeHookRunner([
      {
        name: "context.beforeCompact",
        handler: () => {
          phases.push("before");
        },
      },
      {
        name: "context.afterCompact",
        handler: () => {
          phases.push("after");
        },
      },
    ]);
    const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
      yield { kind: "final", text: "unused" };
    });

    await compactConversationContext({
      conversationId: "c-1",
      agentId: "a-1",
      model: "gpt-5.4",
      workspacePath: "/tmp/workspace",
      items: [msg("user", "one", "m-1"), msg("assistant", "two", "m-2")],
      recentMessageLimit: 2,
      existingSummary: null,
      llm,
      upsertContext: () => {},
      runtimeHooks,
    });

    expect(phases).toEqual([]);
    expect(llm).not.toHaveBeenCalled();
  });

  test("final event overrides deltas if non-empty and empty final keeps accumulated deltas", async () => {
    const overridingLlm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
      yield { kind: "text.delta", text: "delta summary" };
      yield { kind: "final", text: "final summary" };
    });
    const first = baseInput({ llm: overridingLlm });

    await compactConversationContext(first.input);

    expect(first.upserts[0]?.summary).toBe("final summary");

    const emptyFinalLlm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
      yield { kind: "text.delta", text: "delta " };
      yield { kind: "text.delta", text: "summary" };
      yield { kind: "final", text: "" };
    });
    const second = baseInput({ llm: emptyFinalLlm });

    await compactConversationContext(second.input);

    expect(second.upserts[0]?.summary).toBe("delta summary");
  });
});
