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
    // Feed dummy tool results back so await.tool yields don't strand the
    // generator. The DSL discards the resumed value, so any sentinel works.
    let next = await iter.next();
    while (!next.done) {
      next = await iter.next({ ok: true });
    }
    return out;
    // We only care about emitted yields, captured below via a separate path.
  }

  async function collectYields(
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
    let next = await iter.next();
    while (!next.done) {
      out.push(next.value);
      next = await iter.next({ ok: true });
    }
    return out;
  }

  test("emits text deltas, usage, and final from the active step", async () => {
    const controller = makeScriptedLlm();
    controller.setStep({
      yields: [
        { kind: "text.delta", text: "hello " },
        { kind: "text.delta", text: "world" },
        { kind: "usage", usage: { inputTokens: 4, outputTokens: 2 } },
        { kind: "final", text: "hello world" },
      ],
    });

    expect(await collectYields(controller.llm)).toEqual([
      { kind: "text.delta", text: "hello " },
      { kind: "text.delta", text: "world" },
      { kind: "usage", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } },
      { kind: "final", text: "hello world" },
    ]);
  });

  test("expands tool.call into tool.plan + await.tool", async () => {
    const controller = makeScriptedLlm();
    controller.setStep({
      yields: [
        { kind: "tool.call", callId: "c1", tool: "memory_search", input: { query: "x" } },
        { kind: "final", text: "done" },
      ],
    });

    const yields = await collectYields(controller.llm);
    expect(yields).toEqual([
      { kind: "tool.plan", callId: "c1", tool: "memory_search", input: { query: "x" } },
      { kind: "await.tool", callId: "c1" },
      { kind: "final", text: "done" },
    ]);
  });

  test("uses the configured fallback when no step is active", async () => {
    const controller = makeScriptedLlm({
      fallback: { yields: [{ kind: "final", text: "fallback text" }] },
    });
    expect(await collectYields(controller.llm)).toEqual([
      { kind: "final", text: "fallback text" },
    ]);
  });

  test("reset() clears the active step and falls back", async () => {
    const controller = makeScriptedLlm();
    controller.setStep({ yields: [{ kind: "final", text: "first" }] });
    expect(controller.current()).toEqual({ yields: [{ kind: "final", text: "first" }] });
    controller.reset();
    expect(controller.current()).toBeNull();
    const yields = await collectYields(controller.llm);
    // Default fallback mirrors the previous makeStubLlmFallback message so
    // existing acceptance scenarios that don't override the LLM still pass.
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
      yields: [
        { kind: "usage", usage: { inputTokens: 1, outputTokens: 2, totalTokens: 99 } },
        { kind: "final", text: "ok" },
      ],
    });
    const yields = await collectYields(controller.llm);
    expect(yields).toContainEqual({
      kind: "usage",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 99 },
    });
  });

  test("collect helper drains the generator without leaking", async () => {
    const controller = makeScriptedLlm();
    controller.setStep({
      yields: [{ kind: "final", text: "drain ok" }],
    });
    expect(await collect(controller.llm)).toEqual([]);
    // Re-running with the same step still works (controller is reusable).
    expect(await collectYields(controller.llm)).toEqual([
      { kind: "final", text: "drain ok" },
    ]);
  });
});
