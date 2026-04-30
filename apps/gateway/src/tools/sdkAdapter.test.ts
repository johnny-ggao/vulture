import { describe, expect, test } from "bun:test";
import type { ToolCallable } from "@vulture/agent-runtime";
import { RunContext } from "@openai/agents";
import { createCoreToolRegistry } from "./coreTools";
import { resolveEffectiveTools } from "./registry";
import { sdkApprovalDecision, toSdkTool, type GatewayToolRunContext } from "./sdkAdapter";

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
      allow: ["read", "write", "process", "web_fetch", "sessions_list", "update_plan"],
    });

    expect(tools.map((tool) => tool.id)).toEqual([
      "read",
      "write",
      "process",
      "web_fetch",
      "sessions_list",
      "update_plan",
    ]);
    expect(tools.map((tool) => toSdkTool(tool).name)).toEqual([
      "read",
      "write",
      "process",
      "web_fetch",
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
      sessions_list: true,
      sessions_send: false,
      sessions_spawn: false,
      update_plan: true,
      memory_append: false,
      "browser.click": false,
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

  test("uses registry approval policy for shell workspace checks", async () => {
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
      }),
      { cwd: "/tmp/work", argv: ["cat", "/etc/hosts"], timeoutMs: null },
      "c-outside",
    );

    expect(inside).toBe(false);
    expect(outside).toBe(true);
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
});

describe("sdkApprovalDecision", () => {
  test("is exposed as compatibility helper over the shell/browser tool specs", () => {
    expect(
      sdkApprovalDecision("browser.click", { selector: "button" }, "/tmp/work"),
    ).toEqual({
      needsApproval: true,
      reason: "browser.click requires browser approval",
    });
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
