import { describe, expect, test } from "bun:test";
import {
  extractTextDeltaFromRunStreamEvent,
  extractTextDeltaFromRunStreamEventDetails,
  tokenUsageFromSdkUsage,
  makeOpenAILlm,
  makeSdkTool,
  makeStubLlmFallback,
  resolveSdkRunInput,
  sdkStateHasInterruptions,
  sdkApprovalDecision,
  buildSdkUserInput,
  composeSystemPromptWithContext,
  composeUserInputWithContext,
  SdkTextDeltaDeduper,
  type SdkRunEvent,
  type SdkRunContext,
} from "./openaiLlm";
import { RunContext } from "@openai/agents";
import type { LlmYield } from "@vulture/agent-runtime";
import type { ToolCallable } from "@vulture/agent-runtime";

type TestFunctionTool = {
  name: string;
  needsApproval: (context: never, input: unknown, callId?: string) => Promise<boolean>;
  invoke: (context: never, input: string, details?: { toolCall?: { callId?: string } }) => Promise<unknown>;
};

describe("makeOpenAILlm", () => {
  test("builds Agents SDK multimodal user input from attachments", () => {
    expect(
      buildSdkUserInput("describe", [
        {
          id: "att-image",
          kind: "image",
          displayName: "chart.png",
          mimeType: "image/png",
          sizeBytes: 3,
          dataBase64: "aW1n",
        },
        {
          id: "att-file",
          kind: "file",
          displayName: "note.txt",
          mimeType: "text/plain",
          sizeBytes: 4,
          dataBase64: "bm90ZQ==",
        },
      ]),
    ).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "describe" },
          { type: "input_image", image: "data:image/png;base64,aW1n", detail: "auto" },
        {
          type: "input_text",
          text: "Attached file: note.txt\nMIME type: text/plain\nContent:\nnote",
        },
        ],
      },
    ]);
  });

  test("inlines text attachment contents as input_text for file-reading prompts", () => {
    expect(
      buildSdkUserInput("读取文件内容", [
        {
          id: "att-text",
          kind: "file",
          displayName: "1.txt",
          mimeType: "text/plain",
          sizeBytes: 18,
          dataBase64: "SGVsbG8gZnJvbSBmaWxlIQ==",
        },
      ]),
    ).toEqual([
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "读取文件内容" },
          {
            type: "input_text",
            text: "Attached file: 1.txt\nMIME type: text/plain\nContent:\nHello from file!",
          },
        ],
      },
    ]);
  });

  test("keeps run context in agent instructions instead of rewriting the user message", () => {
    const context = [
      "<memories>",
      '  <memory id="mem-1">项目代号是 Vulture。</memory>',
      "</memories>",
    ].join("\n");

    expect(composeSystemPromptWithContext("system", context)).toBe([
      "system",
      "",
      context,
    ].join("\n"));
    expect(composeUserInputWithContext("项目代号是什么？请简单回答", context)).toBe(
      "项目代号是什么？请简单回答",
    );
  });

  test("passes a per-run model provider into the SDK run factory", async () => {
    const providers: unknown[] = [];
    const llm = makeOpenAILlm({
      apiKey: "sk-test",
      toolNames: [],
      toolCallable: async () => "noop",
      runFactory: (input) => {
        providers.push(input.modelProvider);
        return makeMockRun([{ kind: "final", text: "ok" }]);
      },
    });

    for await (const _y of llm({
      systemPrompt: "x",
      userInput: "hi",
      model: "gpt-5.4",
      runId: "r-test",
      workspacePath: "",
    })) {
      // drain
    }

    expect(providers).toHaveLength(1);
    expect(providers[0]).toBeDefined();
  });

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

  test("passes recovery input and checkpoint callback to runFactory", async () => {
    const checkpoints: unknown[] = [];
    const seen: unknown[] = [];
    const llm = makeOpenAILlm({
      apiKey: "sk-test",
      toolNames: [],
      toolCallable: async () => "noop",
      runFactory: (input) => {
        seen.push(input.recovery);
        input.onCheckpoint?.({ sdkState: "sdk-2", activeTool: null });
        return makeMockRun([{ kind: "final", text: "ok" }]);
      },
    });

    for await (const _ of llm({
      systemPrompt: "s",
      userInput: "u",
      model: "gpt-5.4",
      runId: "r",
      workspacePath: "/tmp/work",
      recovery: { sdkState: "sdk-1", retryToolCallId: null },
      onCheckpoint: (c) => checkpoints.push(c),
    })) {}

    expect(seen).toEqual([{ sdkState: "sdk-1", retryToolCallId: null }]);
    expect(checkpoints).toEqual([{ sdkState: "sdk-2", activeTool: null }]);
  });

  test("passes context prompt through runFactory without changing system prompt", async () => {
    const seen: Array<{ systemPrompt: string; userInput: string; contextPrompt?: string }> = [];
    const llm = makeOpenAILlm({
      apiKey: "sk-test",
      toolNames: [],
      toolCallable: async () => "noop",
      runFactory: (input) => {
        seen.push({
          systemPrompt: input.systemPrompt,
          userInput: input.userInput,
          contextPrompt: input.contextPrompt,
        });
        return makeMockRun([{ kind: "final", text: "ok" }]);
      },
    });

    for await (const _ of llm({
      systemPrompt: "system",
      contextPrompt: "<available_skills></available_skills>",
      userInput: "hello",
      model: "gpt-5.4",
      runId: "r",
      workspacePath: "/tmp/work",
    })) {}

    expect(seen).toEqual([
      {
        systemPrompt: "system",
        userInput: "hello",
        contextPrompt: "<available_skills></available_skills>",
      },
    ]);
  });

  test("restores SDK run input with RunState.fromStringWithContext", async () => {
    const agent = {} as never;
    const runContext = {} as never;
    const restored = { restored: true } as never;
    const calls: unknown[] = [];
    const result = await resolveSdkRunInput(
      agent,
      "u",
      { sdkState: "sdk-1", retryToolCallId: null },
      runContext,
      async (...args: unknown[]) => {
        calls.push(args);
        return restored;
      },
    );

    expect(result).toBe(restored);
    expect(calls).toEqual([[agent, "sdk-1", runContext]]);
  });

  test("wraps invalid SDK recovery state errors with protocol code", async () => {
    await expect(
      resolveSdkRunInput(
        {} as never,
        "u",
        { sdkState: "bad-sdk-state", retryToolCallId: null },
        {} as never,
        async () => {
          throw new Error("cannot deserialize");
        },
      ),
    ).rejects.toThrow("internal.recovery_state_invalid");
  });

  test("detects interruptions from restored SDK state", async () => {
    const agent = {} as never;
    const context: SdkRunContext = {
      runId: "r-1",
      workspacePath: "/tmp/work",
      toolCallable: async () => "ok",
      sdkApprovedToolCalls: new Map(),
    };
    const calls: unknown[] = [];

    const result = await sdkStateHasInterruptions(
      { sdkState: "sdk-1", agent, context },
      async (...args: unknown[]) => {
        calls.push(args);
        return { getInterruptions: () => [{ id: "approval-1" }] } as never;
      },
    );

    expect(result).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([agent, "sdk-1", expect.any(RunContext)]);
  });
});

describe("extractTextDeltaFromRunStreamEvent", () => {
  test("deduplicates normalized Responses deltas and their matching raw model events", () => {
    const deduper = new SdkTextDeltaDeduper();
    const normalized = {
      type: "raw_model_stream_event",
      data: {
        type: "output_text_delta",
        delta: "hello",
        providerData: {
          type: "response.output_text.delta",
          item_id: "msg-1",
          output_index: 0,
          content_index: 0,
          sequence_number: 7,
        },
      },
    };
    const raw = {
      type: "raw_model_stream_event",
      data: {
        type: "model",
        event: {
          type: "response.output_text.delta",
          delta: "hello",
          item_id: "msg-1",
          output_index: 0,
          content_index: 0,
          sequence_number: 7,
        },
        providerData: {
          rawModelEventSource: "openai-responses",
        },
      },
    };

    const first = extractTextDeltaFromRunStreamEventDetails(normalized);
    const duplicate = extractTextDeltaFromRunStreamEventDetails(raw);

    expect(first?.text).toBe("hello");
    expect(duplicate?.text).toBe("hello");
    expect(deduper.shouldEmit(first!)).toBe(true);
    expect(deduper.shouldEmit(duplicate!)).toBe(false);
  });

  test("keeps raw Responses deltas as a fallback when no normalized delta preceded them", () => {
    const deduper = new SdkTextDeltaDeduper();
    const raw = {
      type: "raw_model_stream_event",
      data: {
        type: "model",
        event: {
          type: "response.output_text.delta",
          delta: "fallback",
          item_id: "msg-1",
          output_index: 0,
          content_index: 0,
          sequence_number: 8,
        },
      },
    };

    const delta = extractTextDeltaFromRunStreamEventDetails(raw);

    expect(delta?.text).toBe("fallback");
    expect(deduper.shouldEmit(delta!)).toBe(true);
  });

  test("extracts Responses API deltas from the current Agents SDK raw event wrapper", () => {
    const event = {
      type: "raw_model_stream_event",
      data: {
        type: "model",
        event: {
          type: "response.output_text.delta",
          delta: "hello",
        },
        providerData: {
          rawModelEventSource: "openai-responses",
        },
      },
    };

    expect(extractTextDeltaFromRunStreamEvent(event)).toBe("hello");
  });

  test("keeps compatibility with older flat output_text_delta events", () => {
    const event = {
      type: "raw_model_stream_event",
      data: {
        type: "output_text_delta",
        delta: "hello",
      },
    };

    expect(extractTextDeltaFromRunStreamEvent(event)).toBe("hello");
  });
});

describe("tokenUsageFromSdkUsage", () => {
  test("normalizes Agents SDK usage totals", () => {
    expect(
      tokenUsageFromSdkUsage({
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 25,
      totalTokens: 125,
    });
  });

  test("returns null when SDK usage has no token totals", () => {
    expect(
      tokenUsageFromSdkUsage({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
    ).toBe(null);
  });
});

describe("makeSdkTool", () => {
  test("declares SDK approval for shell commands that reference outside-workspace paths", async () => {
    const tool = makeSdkTool("shell.exec") as unknown as TestFunctionTool;

    const needsApproval = await tool.needsApproval(
      { context: { workspacePath: "/tmp/work" } } as never,
      { cwd: "/tmp/work", argv: ["cat", "/etc/hosts"], timeoutMs: null },
      "c-test",
    );

    expect(needsApproval).toBe(true);
  });

  test("does not declare SDK approval for shell commands confined to the workspace", async () => {
    const tool = makeSdkTool("shell.exec") as unknown as TestFunctionTool;

    const needsApproval = await tool.needsApproval(
      { context: { workspacePath: "/tmp/work" } } as never,
      { cwd: "/tmp/work", argv: ["cat", "README.md"], timeoutMs: null },
      "c-test",
    );

    expect(needsApproval).toBe(false);
  });

  test("declares SDK approval when shell cwd is not absolute", async () => {
    const tool = makeSdkTool("shell.exec") as unknown as TestFunctionTool;

    const needsApproval = await tool.needsApproval(
      { context: { workspacePath: process.cwd() } } as never,
      { cwd: "relative", argv: ["cat", "README.md"], timeoutMs: null },
      "c-test",
    );

    expect(needsApproval).toBe(true);
  });

  test("uses API-safe SDK names while invoking Vulture internal tool names", async () => {
    const tool = makeSdkTool("shell.exec") as unknown as TestFunctionTool;
    const calls: Array<{ tool: string; input: unknown }> = [];

    const result = await tool.invoke(
      {
        context: {
          runId: "r-test",
          workspacePath: "/tmp/work",
          toolCallable: async (call: Parameters<ToolCallable>[0]) => {
            calls.push({ tool: call.tool, input: call.input });
            return "ok";
          },
        },
      } as never,
      JSON.stringify({ cwd: "/tmp/work", argv: ["cat", "/etc/hosts"], timeoutMs: null }),
      { toolCall: { callId: "c-test" } },
    );

    expect(tool.name).toBe("shell_exec");
    expect(result).toBe("ok");
    expect(calls).toEqual([
      {
        tool: "shell.exec",
        input: { cwd: "/tmp/work", argv: ["cat", "/etc/hosts"], timeoutMs: null },
      },
    ]);
  });

  test("passes SDK approval tokens to the Vulture tool callback", async () => {
    const tool = makeSdkTool("shell.exec") as unknown as TestFunctionTool;
    const calls: Array<{ approvalToken?: string }> = [];

    await tool.invoke(
      {
        context: {
          runId: "r-test",
          workspacePath: "/tmp/work",
          sdkApprovedToolCalls: new Map([["c-test", "sdk-approved-c-test"]]),
          toolCallable: async (call: Parameters<ToolCallable>[0]) => {
            calls.push({ approvalToken: call.approvalToken });
            return "ok";
          },
        },
      } as never,
      JSON.stringify({ cwd: "/tmp/work", argv: ["cat", "/etc/hosts"], timeoutMs: null }),
      { toolCall: { callId: "c-test" } },
    );

    expect(calls).toEqual([{ approvalToken: "sdk-approved-c-test" }]);
  });

  test("emits active tool checkpoint when SDK tool starts", async () => {
    const tool = makeSdkTool("shell.exec") as unknown as TestFunctionTool;
    const checkpoints: unknown[] = [];
    await tool.invoke(
      {
        context: {
          runId: "r",
          workspacePath: "/tmp/work",
          sdkApprovedToolCalls: new Map(),
          onCheckpoint: (c: unknown) => checkpoints.push(c),
          toolCallable: async () => "ok",
        },
      } as never,
      JSON.stringify({ cwd: "/tmp/work", argv: ["pwd"], timeoutMs: null }),
      { toolCall: { callId: "c1" } },
    );
    expect(checkpoints[0]).toMatchObject({
      activeTool: {
        callId: "c1",
        tool: "shell.exec",
        input: { cwd: "/tmp/work", argv: ["pwd"], timeoutMs: null },
      },
    });
    expect(checkpoints.at(-1)).toMatchObject({ activeTool: null });
  });

  test("clears active tool checkpoint when SDK tool fails", async () => {
    const tool = makeSdkTool("shell.exec") as unknown as TestFunctionTool;
    const checkpoints: unknown[] = [];
    await tool.invoke(
      {
        context: {
          runId: "r",
          workspacePath: "/tmp/work",
          sdkApprovedToolCalls: new Map(),
          onCheckpoint: (c: unknown) => checkpoints.push(c),
          toolCallable: async () => {
            throw new Error("tool boom");
          },
        },
      } as never,
      JSON.stringify({ cwd: "/tmp/work", argv: ["pwd"], timeoutMs: null }),
      { toolCall: { callId: "c1" } },
    );

    expect(checkpoints[0]).toMatchObject({
      activeTool: { callId: "c1", tool: "shell.exec" },
    });
    expect(checkpoints.at(-1)).toMatchObject({ activeTool: null });
  });

  test("emits active tool checkpoints for browser tools", async () => {
    const cases = [
      {
        toolName: "browser.snapshot",
        callId: "c-snapshot",
        input: {},
      },
      {
        toolName: "browser.click",
        callId: "c-click",
        input: { selector: "button.primary" },
      },
    ];

    for (const testCase of cases) {
      const sdkTool = makeSdkTool(testCase.toolName) as unknown as TestFunctionTool;
      const checkpoints: unknown[] = [];
      await sdkTool.invoke(
        {
          context: {
            runId: "r",
            workspacePath: "/tmp/work",
            sdkApprovedToolCalls: new Map(),
            onCheckpoint: (c: unknown) => checkpoints.push(c),
            toolCallable: async () => "ok",
          },
        } as never,
        JSON.stringify(testCase.input),
        { toolCall: { callId: testCase.callId } },
      );

      expect(checkpoints[0]).toMatchObject({
        activeTool: {
          callId: testCase.callId,
          tool: testCase.toolName,
          input: testCase.input,
        },
      });
      expect(checkpoints.at(-1)).toMatchObject({ activeTool: null });
    }
  });
});

describe("sdkApprovalDecision", () => {
  test("matches the Rust policy for browser tools", () => {
    expect(sdkApprovalDecision("browser.click", { selector: "button" }, "/tmp/work")).toEqual({
      needsApproval: true,
      reason: "browser.click requires browser approval",
    });
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
