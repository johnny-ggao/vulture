import { describe, expect, test } from "bun:test";
import type { ToolCallable } from "@vulture/agent-runtime";
import { RunContext } from "@openai/agents";
import { createCoreToolRegistry } from "./coreTools";
import { resolveEffectiveTools } from "./registry";
import { sdkApprovalDecision, toSdkTool, type GatewayToolRunContext } from "./sdkAdapter";
import {
  createRuntimeHookRunner,
  type ToolAfterCallEvent,
  type ToolBeforeCallEvent,
} from "../runtime/runtimeHooks";

type TestFunctionTool = {
  name: string;
  needsApproval: (
    context: RunContext<GatewayToolRunContext>,
    input: unknown,
    callId?: string,
  ) => Promise<boolean>;
  invoke: (
    context: RunContext<GatewayToolRunContext>,
    input: string,
    details?: { toolCall?: { callId?: string } },
  ) => Promise<unknown>;
};

describe("gateway tool sdk adapter", () => {
  test("resolves core tools from the registry before adapting them to SDK tools", () => {
    const registry = createCoreToolRegistry();
    const tools = resolveEffectiveTools(registry, {
      allow: ["read", "write", "process", "web_extract", "sessions_list", "update_plan"],
    });

    expect(tools.map((tool) => tool.id)).toEqual([
      "read",
      "write",
      "process",
      "web_extract",
      "sessions_list",
      "update_plan",
    ]);
    expect(tools.map((tool) => toSdkTool(tool).name)).toEqual([
      "read",
      "write",
      "process",
      "web_extract",
      "sessions_list",
      "update_plan",
    ]);
  });

  test("core tool specs declare retry idempotency explicitly", () => {
    const specs = createCoreToolRegistry().list();

    expect(specs.every((spec) => typeof spec.idempotent === "boolean")).toBe(true);
    expect(Object.fromEntries(specs.map((spec) => [spec.id, spec.idempotent]))).toMatchObject({
      read: true,
      "shell.exec": false,
      web_extract: true,
      sessions_list: true,
      sessions_send: false,
      sessions_spawn: false,
      update_plan: true,
      memory_append: false,
      "browser.click": false,
      "browser.input": false,
      "browser.scroll": false,
      "browser.extract": true,
    });
  });

  test("sessions tools expose durable subagent session fields to the SDK", () => {
    const registry = createCoreToolRegistry();

    expect(registry.get("sessions_list")?.parameters.parse({
      parentConversationId: "c-parent",
      parentRunId: null,
      agentId: null,
      limit: 20,
    })).toMatchObject({ parentConversationId: "c-parent", limit: 20 });
    expect(registry.get("sessions_history")?.parameters.parse({
      sessionId: "sub-1",
      conversationId: null,
      limit: 50,
    })).toMatchObject({ sessionId: "sub-1" });
    expect(registry.get("sessions_send")?.parameters.parse({
      sessionId: "sub-1",
      conversationId: null,
      message: "continue",
    })).toMatchObject({ sessionId: "sub-1", message: "continue" });
    expect(registry.get("sessions_spawn")?.parameters.parse({
      agentId: "researcher",
      title: "Research",
      label: "Researcher",
      message: "collect facts",
    })).toMatchObject({ label: "Researcher" });
    expect(registry.get("sessions_yield")?.parameters.parse({
      parentConversationId: null,
      parentRunId: "r-parent",
      limit: 20,
      message: null,
    })).toMatchObject({ parentRunId: "r-parent" });
  });

  test("fails closed when policy allows an unknown tool", () => {
    const registry = createCoreToolRegistry();

    expect(() =>
      resolveEffectiveTools(registry, {
        allow: ["shell.exec", "missing.tool"],
      }),
    ).toThrow("unknown allowed tool: missing.tool");
  });

  test("treats an empty allowlist as no tools", () => {
    const registry = createCoreToolRegistry();

    expect(resolveEffectiveTools(registry, { allow: [] })).toEqual([]);
  });

  test("default mode allows workspace shell commands but asks for outside paths", async () => {
    const registry = createCoreToolRegistry();
    const shell = registry.get("shell.exec");
    expect(shell).toBeDefined();
    const tool = toSdkTool(shell!) as unknown as TestFunctionTool;

    const inside = await tool.needsApproval(
      new RunContext({
        runId: "r",
        workspacePath: "/tmp/work",
        toolCallable: async () => "ok",
        sdkApprovedToolCalls: new Map(),
        permissionMode: "default",
      }),
      { cwd: "/tmp/work", argv: ["cat", "README.md"], timeoutMs: null },
      "c-inside",
    );
    const outside = await tool.needsApproval(
      new RunContext({
        runId: "r",
        workspacePath: "/tmp/work",
        toolCallable: async () => "ok",
        sdkApprovedToolCalls: new Map(),
        permissionMode: "default",
      }),
      { cwd: "/tmp/work", argv: ["cat", "/etc/hosts"], timeoutMs: null },
      "c-outside",
    );

    expect(inside).toBe(false);
    expect(outside).toBe(true);
  });

  test("default mode allows workspace file writes and asks for outside writes", async () => {
    const registry = createCoreToolRegistry();
    const write = registry.get("write");
    expect(write).toBeDefined();
    const tool = toSdkTool(write!) as unknown as TestFunctionTool;

    const inside = await tool.needsApproval(
      new RunContext({
        runId: "r",
        workspacePath: "/tmp/work",
        toolCallable: async () => "ok",
        sdkApprovedToolCalls: new Map(),
        permissionMode: "default",
      }),
      { path: "notes.txt", content: "ok" },
      "c-inside",
    );
    const outside = await tool.needsApproval(
      new RunContext({
        runId: "r",
        workspacePath: "/tmp/work",
        toolCallable: async () => "ok",
        sdkApprovedToolCalls: new Map(),
        permissionMode: "default",
      }),
      { path: "/etc/hosts", content: "bad" },
      "c-outside",
    );

    expect(inside).toBe(false);
    expect(outside).toBe(true);
  });

  test("read-only mode asks before workspace writes", async () => {
    const registry = createCoreToolRegistry();
    const write = registry.get("write");
    expect(write).toBeDefined();
    const tool = toSdkTool(write!) as unknown as TestFunctionTool;

    const needsApproval = await tool.needsApproval(
      new RunContext({
        runId: "r",
        workspacePath: "/tmp/work",
        toolCallable: async () => "ok",
        sdkApprovedToolCalls: new Map(),
        permissionMode: "read_only",
      }),
      { path: "notes.txt", content: "ok" },
      "c-write",
    );

    expect(needsApproval).toBe(true);
  });

  test("public web tools do not ask for approval but private web fetch does", async () => {
    const registry = createCoreToolRegistry();
    const searchTool = toSdkTool(registry.get("web_search")!) as unknown as TestFunctionTool;
    const fetchTool = toSdkTool(registry.get("web_fetch")!) as unknown as TestFunctionTool;
    const extractTool = toSdkTool(registry.get("web_extract")!) as unknown as TestFunctionTool;
    const context = new RunContext<GatewayToolRunContext>({
      runId: "r",
      workspacePath: "/tmp/work",
      toolCallable: async () => "ok",
      sdkApprovedToolCalls: new Map(),
      permissionMode: "default",
    });

    await expect(searchTool.needsApproval(context, { query: "vulture", limit: null }, "c-search"))
      .resolves.toBe(false);
    await expect(
      fetchTool.needsApproval(
        context,
        { url: "https://example.com", maxBytes: null },
        "c-fetch-public",
      ),
    ).resolves.toBe(false);
    await expect(
      extractTool.needsApproval(
        context,
        { url: "https://example.com", maxBytes: null, maxLinks: null },
        "c-extract-public",
      ),
    ).resolves.toBe(false);
    await expect(
      fetchTool.needsApproval(
        context,
        { url: "http://localhost:3000", maxBytes: null },
        "c-fetch-private",
      ),
    ).resolves.toBe(true);
  });

  test("full access context bypasses SDK needsApproval", async () => {
    const registry = createCoreToolRegistry();
    const shell = registry.get("shell.exec");
    expect(shell).toBeDefined();
    const tool = toSdkTool(shell!) as unknown as TestFunctionTool;

    const outside = await tool.needsApproval(
      new RunContext({
        runId: "r",
        workspacePath: "/tmp/work",
        toolCallable: async () => "ok",
        sdkApprovedToolCalls: new Map(),
        permissionMode: "full_access",
      }),
      { cwd: "/tmp/work", argv: ["cat", "/etc/hosts"], timeoutMs: null },
      "c-outside",
    );

    expect(outside).toBe(false);
  });

  test("passes SDK approval tokens through the registry executor", async () => {
    const registry = createCoreToolRegistry();
    const shell = registry.get("shell.exec");
    expect(shell).toBeDefined();
    const tool = toSdkTool(shell!) as unknown as TestFunctionTool;
    const calls: Array<{ tool: string; approvalToken?: string }> = [];

    await tool.invoke(
      new RunContext({
        runId: "r-test",
        workspacePath: "/tmp/work",
        sdkApprovedToolCalls: new Map([["c-test", "sdk-approved-c-test"]]),
        toolCallable: async (call: Parameters<ToolCallable>[0]) => {
          calls.push({ tool: call.tool, approvalToken: call.approvalToken });
          return "ok";
        },
      }),
      JSON.stringify({ cwd: "/tmp/work", argv: ["cat", "/etc/hosts"], timeoutMs: null }),
      { toolCall: { callId: "c-test" } },
    );

    expect(calls).toEqual([{ tool: "shell.exec", approvalToken: "sdk-approved-c-test" }]);
  });

  test("full access context passes a synthetic approval token to local executors", async () => {
    const registry = createCoreToolRegistry();
    const write = registry.get("write");
    expect(write).toBeDefined();
    const tool = toSdkTool(write!) as unknown as TestFunctionTool;
    const calls: Array<{ tool: string; approvalToken?: string }> = [];

    await tool.invoke(
      new RunContext({
        runId: "r-test",
        workspacePath: "/tmp/work",
        permissionMode: "full_access",
        sdkApprovedToolCalls: new Map(),
        toolCallable: async (call: Parameters<ToolCallable>[0]) => {
          calls.push({ tool: call.tool, approvalToken: call.approvalToken });
          return "ok";
        },
      }),
      JSON.stringify({ path: "out.txt", content: "x" }),
      { toolCall: { callId: "c-write" } },
    );

    expect(calls).toEqual([{ tool: "write", approvalToken: "full-access" }]);
  });

  test("records idempotency in active tool checkpoints", async () => {
    const registry = createCoreToolRegistry();
    const read = registry.get("read");
    expect(read).toBeDefined();
    const tool = toSdkTool(read!) as unknown as TestFunctionTool;
    const checkpoints: GatewayToolRunContext["onCheckpoint"][] = [];

    await tool.invoke(
      new RunContext({
        runId: "r-test",
        workspacePath: "/tmp/work",
        sdkApprovedToolCalls: new Map(),
        toolCallable: async () => "ok",
        onCheckpoint: (checkpoint) => {
          checkpoints.push(checkpoint as never);
        },
      }),
      JSON.stringify({ path: "README.md", maxBytes: null }),
      { toolCall: { callId: "c-read" } },
    );

    expect(checkpoints[0]).toMatchObject({
      activeTool: {
        callId: "c-read",
        tool: "read",
        idempotent: true,
      },
    });
  });

  test("runs runtime tool hooks around SDK tool execution", async () => {
    const registry = createCoreToolRegistry();
    const read = registry.get("read");
    expect(read).toBeDefined();
    const tool = toSdkTool(read!) as unknown as TestFunctionTool;
    const calls: Array<{ phase: string; input?: unknown; outcome?: string }> = [];
    const runtimeHooks = createRuntimeHookRunner([
      {
        name: "tool.beforeCall",
        handler: async (event) => {
          calls.push({ phase: "before", input: (event as ToolBeforeCallEvent).input });
          return { input: { path: "patched.txt", maxBytes: null } };
        },
      },
      {
        name: "tool.afterCall",
        handler: async (event) => {
          const toolEvent = event as ToolAfterCallEvent;
          calls.push({ phase: "after", input: toolEvent.input, outcome: toolEvent.outcome });
        },
      },
    ]);
    const toolCalls: Array<{ input: unknown }> = [];

    await tool.invoke(
      new RunContext({
        runId: "r-test",
        workspacePath: "/tmp/work",
        sdkApprovedToolCalls: new Map(),
        runtimeHooks,
        toolCallable: async (call: Parameters<ToolCallable>[0]) => {
          toolCalls.push({ input: call.input });
          return "ok";
        },
      }),
      JSON.stringify({ path: "original.txt", maxBytes: null }),
      { toolCall: { callId: "c-read" } },
    );

    expect(toolCalls).toEqual([{ input: { path: "patched.txt", maxBytes: null } }]);
    expect(calls).toEqual([
      { phase: "before", input: { path: "original.txt", maxBytes: null } },
      { phase: "after", input: { path: "patched.txt", maxBytes: null }, outcome: "completed" },
    ]);
  });

  test("preserves a hook's explicit null input patch instead of falling back to the original", async () => {
    const registry = createCoreToolRegistry();
    const read = registry.get("read");
    expect(read).toBeDefined();
    const tool = toSdkTool(read!) as unknown as TestFunctionTool;
    const runtimeHooks = createRuntimeHookRunner([
      {
        name: "tool.beforeCall",
        handler: async () => ({ input: null }),
      },
    ]);
    const observed: Array<{ input: unknown }> = [];

    await tool.invoke(
      new RunContext({
        runId: "r-test",
        workspacePath: "/tmp/work",
        sdkApprovedToolCalls: new Map(),
        runtimeHooks,
        toolCallable: async (call: Parameters<ToolCallable>[0]) => {
          observed.push({ input: call.input });
          return "ok";
        },
      }),
      JSON.stringify({ path: "original.txt", maxBytes: null }),
      { toolCall: { callId: "c-null" } },
    );

    expect(observed).toEqual([{ input: null }]);
  });

  test("blocks SDK tool execution when runtime hook denies it", async () => {
    const registry = createCoreToolRegistry();
    const write = registry.get("write");
    expect(write).toBeDefined();
    const tool = toSdkTool(write!) as unknown as TestFunctionTool;
    const runtimeHooks = createRuntimeHookRunner([
      {
        name: "tool.beforeCall",
        handler: async () => ({ block: true, blockReason: "policy denied" }),
      },
    ]);

    const result = await tool.invoke(
      new RunContext({
        runId: "r-test",
        workspacePath: "/tmp/work",
        sdkApprovedToolCalls: new Map(),
        runtimeHooks,
        toolCallable: async () => "should-not-run",
      }),
      JSON.stringify({ path: "out.txt", content: "x" }),
      { toolCall: { callId: "c-write" } },
    );

    expect(String(result)).toContain("policy denied");
  });
});

describe("sdkApprovalDecision", () => {
  test("is exposed as compatibility helper over the shell/browser tool specs", () => {
    expect(
      sdkApprovalDecision("browser.click", { selector: "button" }, "/tmp/work"),
    ).toEqual({
      needsApproval: true,
      reason: "browser.click requires browser approval",
    });
    expect(
      sdkApprovalDecision("browser.input", { selector: "input", text: "hello" }, "/tmp/work"),
    ).toEqual({
      needsApproval: true,
      reason: "browser.input requires browser approval",
    });
  });

  test("compatibility helper uses default workspace-write permissions", () => {
    expect(
      sdkApprovalDecision("write", { path: "inside.txt", content: "ok" }, "/tmp/work"),
    ).toEqual({ needsApproval: false });
    expect(
      sdkApprovalDecision("write", { path: "/etc/hosts", content: "bad" }, "/tmp/work"),
    ).toEqual({ needsApproval: true, reason: "write outside workspace" });
  });

  test("explains subagent spawn approvals as agent suggestions", () => {
    expect(
      sdkApprovalDecision(
        "sessions_spawn",
        {
          agentId: "researcher",
          label: "Researcher",
          title: "Investigate Openclaw tools",
          message: "Compare the Openclaw tool system with Vulture.",
        },
        "/tmp/work",
      ),
    ).toEqual({
      needsApproval: true,
      reason: "建议开启子智能体 Researcher：Investigate Openclaw tools",
    });
  });
});
