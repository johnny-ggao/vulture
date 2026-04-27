import { describe, expect, test } from "bun:test";
import { makeOpenAILlm } from "./openaiLlm";

const SKIP = !process.env.OPENAI_API_KEY;

describe.skipIf(SKIP)("openaiLlm smoke (real API)", () => {
  test("real API call yields at least one final event", async () => {
    const llm = makeOpenAILlm({
      apiKey: process.env.OPENAI_API_KEY!,
      toolNames: [],
      toolCallable: async () => "noop",
    });
    const kinds: string[] = [];
    for await (const y of llm({
      systemPrompt: "Reply with a single word.",
      userInput: "hi",
      model: "gpt-4o-mini",
      runId: "r-smoke",
      workspacePath: "",
    })) {
      kinds.push(y.kind);
    }
    expect(kinds).toContain("final");
  }, 30_000);
});
