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
      allow: ["shell.exec", "browser.click"],
    });

    expect(tools.map((tool) => tool.id)).toEqual(["shell.exec", "browser.click"]);
    expect(tools.map((tool) => toSdkTool(tool).name)).toEqual(["shell_exec", "browser_click"]);
  });

  test("fails closed when policy allows an unknown tool", () => {
    const registry = createCoreToolRegistry();

    expect(() =>
      resolveEffectiveTools(registry, {
        allow: ["shell.exec", "missing.tool"],
      }),
    ).toThrow("unknown allowed tool: missing.tool");
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
});
