import { describe, expect, test, mock } from "bun:test";
import { runConversation, ToolCallError, type LlmCallable, type LlmYield, type ToolCallable } from "./runner";

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
});
