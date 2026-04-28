import { describe, expect, test, mock } from "bun:test";
import {
  runConversation,
  ToolCallError,
  type LlmCallable,
  type LlmCheckpoint,
  type LlmRecoveryInput,
  type LlmYield,
  type ToolCallable,
} from "./runner";

describe("runConversation", () => {
  test("happy path: LLM returns text → emits run.started + text.delta + run.completed", async () => {
    const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
      yield { kind: "text.delta", text: "Hello, " };
      yield { kind: "text.delta", text: "world." };
      yield { kind: "final", text: "Hello, world." };
    });
    const tools: ToolCallable = mock(async () => {
      throw new Error("should not be called in this test");
    });
    const events: Array<{ type: string }> = [];

    const result = await runConversation({
      runId: "r-1",
      agentId: "a-1",
      model: "gpt-5.4",
      systemPrompt: "ignored",
      userInput: "hi",
      workspacePath: "",
      llm,
      tools,
      onEvent: (e) => events.push({ type: e.type }),
    });

    expect(result.status).toBe("succeeded");
    expect(result.finalText).toBe("Hello, world.");
    const types = events.map((e) => e.type);
    expect(types).toContain("run.started");
    expect(types).toContain("text.delta");
    expect(types[types.length - 1]).toBe("run.completed");
  });

  test("ToolCallError code preservation: tool throws ToolCallError → tool.failed uses that code", async () => {
    const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
      yield { kind: "tool.plan", callId: "c1", tool: "shell.exec", input: {} };
      yield { kind: "await.tool", callId: "c1" };
      yield { kind: "final", text: "unreachable" };
    });
    const tools: ToolCallable = mock(async () => {
      throw new ToolCallError("tool.permission_denied", "denied by policy");
    });
    const events: Array<{ type: string; error?: { code: string } }> = [];

    const result = await runConversation({
      runId: "r-code",
      agentId: "a-1",
      model: "gpt-5.4",
      systemPrompt: "ignored",
      userInput: "do it",
      workspacePath: "",
      llm,
      tools,
      onEvent: (e) => events.push(e as { type: string; error?: { code: string } }),
    });

    expect(result.status).toBe("failed");
    const toolFailed = events.find((e) => e.type === "tool.failed");
    expect(toolFailed).toBeDefined();
    expect(toolFailed?.error?.code).toBe("tool.permission_denied");
  });

  test("tool call path: LLM yields tool plan → tools(...) is called → result feeds back", async () => {
    let toolCalls = 0;
    const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
      yield { kind: "tool.plan", callId: "c1", tool: "shell.exec", input: { argv: ["ls"] } };
      const result = yield { kind: "await.tool", callId: "c1" };
      yield { kind: "text.delta", text: `tool returned: ${JSON.stringify(result)}` };
      yield { kind: "final", text: "Done." };
    });
    let capturedWorkspacePath = "";
    const tools: ToolCallable = mock(async ({ tool, input, workspacePath }) => {
      toolCalls += 1;
      capturedWorkspacePath = workspacePath;
      return { stdout: "(mock output)", tool, echoedInput: input };
    });

    const result = await runConversation({
      runId: "r-2",
      agentId: "a-1",
      model: "gpt-5.4",
      systemPrompt: "ignored",
      userInput: "ls",
      workspacePath: "/tmp/test-workspace",
      llm,
      tools,
      onEvent: () => undefined,
    });

    expect(result.status).toBe("succeeded");
    expect(toolCalls).toBe(1);
    expect(capturedWorkspacePath).toBe("/tmp/test-workspace");
  });

  test("preserves streamed text when final event is empty", async () => {
    const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
      yield { kind: "text.delta", text: "Here is the result." };
      yield { kind: "final", text: "" };
    });
    const tools: ToolCallable = mock(async () => {
      throw new Error("should not be called in this test");
    });

    const result = await runConversation({
      runId: "r-empty-final",
      agentId: "a-1",
      model: "gpt-5.4",
      systemPrompt: "ignored",
      userInput: "hi",
      workspacePath: "",
      llm,
      tools,
      onEvent: () => undefined,
    });

    expect(result.status).toBe("succeeded");
    expect(result.finalText).toBe("Here is the result.");
  });

  test("emits token usage before run.completed when LLM reports usage", async () => {
    const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
      yield {
        kind: "usage",
        usage: { inputTokens: 100, outputTokens: 25, totalTokens: 125 },
      };
      yield { kind: "final", text: "Done." };
    });
    const events: Array<{ type: string; usage?: { totalTokens: number } }> = [];

    const result = await runConversation({
      runId: "r-usage",
      agentId: "a-1",
      model: "gpt-5.4",
      systemPrompt: "ignored",
      userInput: "hi",
      workspacePath: "",
      llm,
      tools: async () => ({}),
      onEvent: (e) => events.push(e as { type: string; usage?: { totalTokens: number } }),
    });

    expect(result.status).toBe("succeeded");
    expect(result.usage?.totalTokens).toBe(125);
    expect(events.map((e) => e.type)).toEqual([
      "run.started",
      "run.usage",
      "run.completed",
    ]);
    expect(events[1].usage?.totalTokens).toBe(125);
  });

  test("passes recovery options through to llm", async () => {
    const recovery: LlmRecoveryInput = { sdkState: "resume-state", retryToolCallId: null };
    const checkpoint: LlmCheckpoint = { sdkState: "checkpoint", activeTool: null };
    let seen: unknown;
    const checkpoints: LlmCheckpoint[] = [];
    const llm: LlmCallable = mock(async function* (
      input: Parameters<LlmCallable>[0],
    ): AsyncGenerator<LlmYield, void, unknown> {
      seen = input.recovery;
      input.onCheckpoint?.(checkpoint);
      yield { kind: "final", text: "ok" };
    });

    const result = await runConversation({
      runId: "r-recovery",
      agentId: "a-1",
      model: "gpt-5.4",
      systemPrompt: "ignored",
      userInput: "resume",
      workspacePath: "",
      llm,
      tools: async () => ({}),
      onEvent: () => undefined,
      recovery,
      onCheckpoint: (value) => checkpoints.push(value),
    });

    expect(result.status).toBe("succeeded");
    expect(seen).toEqual(recovery);
    expect(checkpoints).toEqual([checkpoint]);
  });

  test("passes attachments through to llm", async () => {
    let seen: unknown;
    const llm: LlmCallable = mock(async function* (
      input: Parameters<LlmCallable>[0],
    ): AsyncGenerator<LlmYield, void, unknown> {
      seen = input.attachments;
      yield { kind: "final", text: "ok" };
    });
    const attachments = [
      {
        id: "att-1",
        kind: "image" as const,
        displayName: "image.png",
        mimeType: "image/png",
        sizeBytes: 4,
        dataBase64: "aW1n",
      },
    ];

    const result = await runConversation({
      runId: "r-attachments",
      agentId: "a-1",
      model: "gpt-5.4",
      systemPrompt: "ignored",
      userInput: "describe",
      attachments,
      workspacePath: "",
      llm,
      tools: async () => ({}),
      onEvent: () => undefined,
    });

    expect(result.status).toBe("succeeded");
    expect(seen).toEqual(attachments);
  });

  test("fails when the LLM stream is idle past the timeout", async () => {
    const events: Array<{ type: string; error?: { message: string } }> = [];
    const llm: LlmCallable = mock(async function* (): AsyncGenerator<LlmYield, void, unknown> {
      await new Promise(() => {});
    });

    const result = await runConversation({
      runId: "r-idle",
      agentId: "a-1",
      model: "gpt-5.4",
      systemPrompt: "ignored",
      userInput: "hi",
      workspacePath: "",
      llm,
      tools: async () => ({}),
      onEvent: (e) => events.push(e as { type: string; error?: { message: string } }),
      idleTimeoutMs: 5,
    });

    expect(result.status).toBe("failed");
    const failed = events.find((e) => e.type === "run.failed");
    expect(failed?.error?.message).toContain("LLM stream idle timeout");
  });
});
