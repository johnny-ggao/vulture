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
