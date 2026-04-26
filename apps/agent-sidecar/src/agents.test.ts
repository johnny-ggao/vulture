import { afterEach, describe, expect, test } from "bun:test";
import { createLocalWorkAgent, runAgent } from "./agents";

const validRunParams = {
  profileId: "default",
  workspaceId: "vulture",
  agentId: "local-work-agent",
  input: "hello",
};

describe("agent mock mode", () => {
  const originalAgentMode = process.env.VULTURE_AGENT_MODE;
  const originalMockToolRequest = process.env.VULTURE_MOCK_TOOL_REQUEST;

  afterEach(() => {
    process.env.VULTURE_AGENT_MODE = originalAgentMode;
    process.env.VULTURE_MOCK_TOOL_REQUEST = originalMockToolRequest;
  });

  test("emits shell.exec tool request with the active run id when enabled", async () => {
    process.env.VULTURE_AGENT_MODE = "mock";
    process.env.VULTURE_MOCK_TOOL_REQUEST = "1";
    const requests: unknown[] = [];

    const events = await runAgent(validRunParams, (runId) => ({
      request: async (tool, input) => {
        requests.push({ runId, tool, input });
        return { ok: false };
      },
    }));

    expect(requests).toEqual([
      {
        runId: events[0].runId,
        tool: "shell.exec",
        input: { cwd: "/tmp", argv: ["pwd"], timeoutMs: 120000 },
      },
    ]);
  });
});

describe("local work agent", () => {
  test("registers shell and browser tools", () => {
    const agent = createLocalWorkAgent({
      request: async () => ({ ok: true }),
    });

    expect(agent.tools.map((tool) => tool.name)).toEqual([
      "shell_exec",
      "browser_snapshot",
      "browser_click",
    ]);
  });
});
