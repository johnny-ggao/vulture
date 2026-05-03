import { describe, expect, test } from "bun:test";
import { makeScriptedLlm } from "./scriptedLlm";

describe("scripted LLM", () => {
  async function collect(
    llm: ReturnType<typeof makeScriptedLlm>["llm"],
  ): Promise<unknown[]> {
    const out: unknown[] = [];
    const iter = llm({
      systemPrompt: "",
      userInput: "anything",
      runId: "r-test",
      workspacePath: "/tmp",
      model: "scripted-llm",
    });
    for await (const value of iter) out.push(value);
    return out;
  }

  test("emits deltas, usage, and final from the active step", async () => {
    const controller = makeScriptedLlm();
    controller.setStep({
      deltas: ["hello ", "world"],
      final: "hello world",
      usage: { inputTokens: 4, outputTokens: 2 },
    });

    expect(await collect(controller.llm)).toEqual([
      { kind: "text.delta", text: "hello " },
      { kind: "text.delta", text: "world" },
      { kind: "usage", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
      { kind: "final", text: "hello world" },
    ]);
  });

  test("uses the configured fallback when no step is active", async () => {
    const controller = makeScriptedLlm({
      fallback: { final: "fallback text" },
    });
    expect(await collect(controller.llm)).toEqual([
      { kind: "final", text: "fallback text" },
    ]);
  });

  test("reset() clears the active step and falls back", async () => {
    const controller = makeScriptedLlm();
    controller.setStep({ final: "first" });
    expect(controller.current()).toEqual({ final: "first" });
    controller.reset();
    expect(controller.current()).toBeNull();
    const yields = await collect(controller.llm);
    // Default fallback is the OPENAI_API_KEY-not-configured message used by
    // existing acceptance scenarios that don't override the LLM.
    expect(yields).toEqual([
      {
        kind: "final",
        text: "OPENAI_API_KEY not configured. Set the key via Settings or set the env var, then retry.",
      },
    ]);
  });

  test("emits totalTokens when the script supplies it explicitly", async () => {
    const controller = makeScriptedLlm();
    controller.setStep({
      final: "ok",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 99 },
    });
    const yields = await collect(controller.llm);
    expect(yields).toContainEqual({
      kind: "usage",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 99 },
    });
  });
});
