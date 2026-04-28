import { describe, expect, mock, test } from "bun:test";
import type { LlmCallable, LlmYield } from "@vulture/agent-runtime";
import { extractMemorySuggestions } from "./memorySuggestionExtractor";

describe("extractMemorySuggestions", () => {
  test("parses JSON suggestions from a no-tools LLM pass", async () => {
    const llm: LlmCallable = mock(async function* (
      input: Parameters<LlmCallable>[0],
    ): AsyncGenerator<LlmYield, void, unknown> {
      expect(input.contextPrompt).toBeUndefined();
      expect(input.userInput).toContain("User message:");
      yield {
        kind: "final",
        text: JSON.stringify({
          suggestions: [
            {
              content: "Project codename is Vulture.",
              reason: "The user confirmed the durable project codename.",
              targetPath: "MEMORY.md",
            },
          ],
        }),
      };
    });

    const suggestions = await extractMemorySuggestions({
      llm,
      model: "gpt-5.4",
      workspacePath: "/tmp/work",
      runId: "r-1",
      userInput: "项目代号是 Vulture",
      assistantOutput: "已记住。",
      memorySummary: "",
    });

    expect(suggestions).toEqual([
      {
        content: "Project codename is Vulture.",
        reason: "The user confirmed the durable project codename.",
        targetPath: "MEMORY.md",
      },
    ]);
  });

  test("returns an empty list when the extractor output is not valid JSON", async () => {
    const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
      yield { kind: "final", text: "no durable memories" };
    });

    const suggestions = await extractMemorySuggestions({
      llm,
      model: "gpt-5.4",
      workspacePath: "/tmp/work",
      runId: "r-1",
      userInput: "hello",
      assistantOutput: "hi",
      memorySummary: "",
    });

    expect(suggestions).toEqual([]);
  });
});
