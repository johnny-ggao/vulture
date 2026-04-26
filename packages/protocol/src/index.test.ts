import { describe, expect, test } from "bun:test";
import {
  JsonRpcRequest,
  RunCreateParams,
  ToolRequestParams,
  makeEvent,
} from "./index";

describe("protocol schemas", () => {
  test("validates run.create params", () => {
    const parsed = RunCreateParams.parse({
      profileId: "default",
      workspaceId: "vulture",
      agentId: "local-work-agent",
      input: "summarize this repo",
    });

    expect(parsed.agentId).toBe("local-work-agent");
  });

  test("validates run.create with agent and workspace snapshots", () => {
    const parsed = RunCreateParams.parse({
      profileId: "default",
      workspaceId: "vulture",
      agentId: "local-work-agent",
      input: "summarize this repo",
      agent: {
        id: "local-work-agent",
        name: "Local Work Agent",
        instructions: "You are a local work agent.",
        model: "gpt-5.4",
        tools: ["shell.exec", "browser.snapshot", "browser.click"],
      },
      workspace: {
        id: "vulture",
        path: "/Users/johnny/Work/vulture",
      },
    });

    expect(parsed.agent?.tools).toEqual(["shell.exec", "browser.snapshot", "browser.click"]);
    expect(parsed.workspace?.path).toBe("/Users/johnny/Work/vulture");
  });

  test("rejects unsupported agent snapshot tools", () => {
    expect(() =>
      RunCreateParams.parse({
        profileId: "default",
        workspaceId: "vulture",
        agentId: "local-work-agent",
        input: "hello",
        agent: {
          id: "local-work-agent",
          name: "Local Work Agent",
          instructions: "You are a local work agent.",
          model: "gpt-5.4",
          tools: ["file.write"],
        },
        workspace: {
          id: "vulture",
          path: "/Users/johnny/Work/vulture",
        },
      }),
    ).toThrow();
  });

  test("validates shell tool requests as argv", () => {
    const parsed = ToolRequestParams.parse({
      runId: "run_1",
      tool: "shell.exec",
      input: {
        cwd: "/tmp/workspace",
        argv: ["bun", "test"],
        timeoutMs: 120000,
      },
    });

    expect(parsed.tool).toBe("shell.exec");
  });

  test("validates specific browser tool requests", () => {
    for (const tool of ["browser.snapshot", "browser.click"] as const) {
      const parsed = ToolRequestParams.parse({
        runId: "run_1",
        tool,
        input: { tabId: 1 },
      });

      expect(parsed.tool).toBe(tool);
    }
  });

  test("rejects raw browser control alias", () => {
    expect(() =>
      ToolRequestParams.parse({
        runId: "run_1",
        tool: "browser.control",
        input: {},
      }),
    ).toThrow();
  });

  test("rejects git tool requests without a suffix", () => {
    expect(() =>
      ToolRequestParams.parse({
        runId: "run_1",
        tool: "git.",
        input: {},
      }),
    ).toThrow();
  });

  test("rejects rpc requests without a method", () => {
    expect(() => JsonRpcRequest.parse({ id: "1", params: {} })).toThrow();
  });

  test("creates typed events", () => {
    const event = makeEvent("run_1", "model_delta", { text: "hello" });
    expect(event.type).toBe("model_delta");
    expect(event.runId).toBe("run_1");
  });
});
