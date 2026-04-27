import { describe, expect, test } from "bun:test";
import {
  makeOpenAILlm,
  makeStubLlmFallback,
  type SdkRunEvent,
} from "./openaiLlm";
import type { LlmYield } from "@vulture/agent-runtime";

describe("makeOpenAILlm", () => {
  test("translates SDK text.delta and final events into LlmYield", async () => {
    const sdkEvents: SdkRunEvent[] = [
      { kind: "text.delta", text: "Hello, " },
      { kind: "text.delta", text: "world." },
      { kind: "final", text: "Hello, world." },
    ];
    const llm = makeOpenAILlm({
      apiKey: "sk-test",
      toolNames: ["shell.exec"],
      toolCallable: async () => "noop",
      runFactory: () => makeMockRun(sdkEvents),
    });
    const yields: LlmYield[] = [];
    for await (const y of llm({
      systemPrompt: "x",
      userInput: "hi",
      model: "gpt-5.4",
      runId: "r-test",
      workspacePath: "",
    })) {
      yields.push(y);
    }
    expect(yields.map((y) => y.kind)).toEqual(["text.delta", "text.delta", "final"]);
  });

  test("translates SDK tool_call events into tool.plan + await.tool", async () => {
    const sdkEvents: SdkRunEvent[] = [
      { kind: "tool.plan", callId: "c1", tool: "shell.exec", input: { argv: ["ls"] } },
      { kind: "await.tool", callId: "c1" },
      { kind: "final", text: "done" },
    ];
    const llm = makeOpenAILlm({
      apiKey: "sk-test",
      toolNames: ["shell.exec"],
      toolCallable: async () => "noop",
      runFactory: () => makeMockRun(sdkEvents),
    });
    const yields: LlmYield[] = [];
    for await (const y of llm({
      systemPrompt: "x",
      userInput: "hi",
      model: "gpt-5.4",
      runId: "r-test",
      workspacePath: "",
    })) {
      yields.push(y);
    }
    expect(yields.map((y) => y.kind)).toEqual(["tool.plan", "await.tool", "final"]);
    expect(yields[0]).toMatchObject({ tool: "shell.exec" });
  });
});

describe("makeStubLlmFallback", () => {
  test("yields a single configuration-needed final message", async () => {
    const llm = makeStubLlmFallback();
    const yields: LlmYield[] = [];
    for await (const y of llm({
      systemPrompt: "x",
      userInput: "hi",
      model: "gpt-5.4",
      runId: "r-test",
      workspacePath: "",
    })) {
      yields.push(y);
    }
    expect(yields).toHaveLength(1);
    expect(yields[0].kind).toBe("final");
    if (yields[0].kind === "final") {
      expect(yields[0].text).toContain("OPENAI_API_KEY");
    }
  });
});

async function* makeMockRun(events: SdkRunEvent[]) {
  for (const e of events) yield e;
}
