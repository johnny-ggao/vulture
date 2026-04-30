import { describe, expect, test } from "bun:test";
import { createRuntimeHookRunner, type RuntimeHookRegistration } from "./runtimeHooks";

describe("RuntimeHookRunner", () => {
  test("runs observation hooks without surfacing fail-open errors", async () => {
    const calls: string[] = [];
    const runner = createRuntimeHookRunner(
      [
        {
          name: "run.afterStart",
          handler: async () => {
            calls.push("first");
          },
        },
        {
          name: "run.afterStart",
          handler: async () => {
            calls.push("second");
            throw new Error("boom");
          },
        },
      ],
      { logger: { warn: () => undefined, error: () => undefined } },
    );

    await expect(
      runner.emit("run.afterStart", {
        runId: "r-1",
        conversationId: "c-1",
        agentId: "a-1",
        model: "gpt-5.4",
        workspacePath: "/tmp/work",
        recovery: false,
      }),
    ).resolves.toBeUndefined();
    expect(calls.sort()).toEqual(["first", "second"]);
  });

  test("tool.beforeCall applies priority-ordered input patches", async () => {
    const registrations: RuntimeHookRegistration[] = [
      {
        name: "tool.beforeCall",
        priority: 10,
        handler: async () => ({ input: { path: "high.txt" } }),
      },
      {
        name: "tool.beforeCall",
        priority: 0,
        handler: async () => ({ input: { path: "low.txt" } }),
      },
    ];
    const runner = createRuntimeHookRunner(registrations);

    const decision = await runner.runToolBeforeCall({
      runId: "r-1",
      workspacePath: "/tmp/work",
      callId: "c-1",
      toolId: "read",
      input: { path: "original.txt" },
    });

    expect(decision).toEqual({
      blocked: false,
      input: { path: "low.txt" },
    });
  });

  test("tool.beforeCall stops when a hook blocks", async () => {
    const calls: string[] = [];
    const runner = createRuntimeHookRunner([
      {
        name: "tool.beforeCall",
        priority: 20,
        handler: async () => {
          calls.push("blocker");
          return { block: true, blockReason: "not allowed" };
        },
      },
      {
        name: "tool.beforeCall",
        priority: 0,
        handler: async () => {
          calls.push("lower");
        },
      },
    ]);

    const decision = await runner.runToolBeforeCall({
      runId: "r-1",
      workspacePath: "/tmp/work",
      callId: "c-1",
      toolId: "write",
      input: { path: "out.txt" },
    });

    expect(decision).toMatchObject({ blocked: true, reason: "not allowed" });
    expect(calls).toEqual(["blocker"]);
  });

  test("tool.beforeCall fails closed by default", async () => {
    const runner = createRuntimeHookRunner([
      {
        name: "tool.beforeCall",
        handler: async () => {
          throw new Error("policy unavailable");
        },
      },
    ]);

    const decision = await runner.runToolBeforeCall({
      runId: "r-1",
      workspacePath: "/tmp/work",
      callId: "c-1",
      toolId: "shell.exec",
      input: { argv: ["pwd"] },
    });

    expect(decision.blocked).toBe(true);
    expect(decision.reason).toContain("policy unavailable");
  });
});
