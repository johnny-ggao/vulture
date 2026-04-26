import { afterEach, describe, expect, test } from "bun:test";
import { createAgentFromConfig, createLocalWorkAgent, runAgent } from "./agents";

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
    if (originalAgentMode === undefined) {
      delete process.env.VULTURE_AGENT_MODE;
    } else {
      process.env.VULTURE_AGENT_MODE = originalAgentMode;
    }

    if (originalMockToolRequest === undefined) {
      delete process.env.VULTURE_MOCK_TOOL_REQUEST;
    } else {
      process.env.VULTURE_MOCK_TOOL_REQUEST = originalMockToolRequest;
    }
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

  test("creates agent from runtime config", () => {
    const agent = createAgentFromConfig(
      {
        id: "researcher",
        name: "Researcher",
        instructions: "Research with the browser.",
        model: "gpt-5.4",
        tools: ["browser.snapshot"],
      },
      {
        request: async () => ({ ok: true }),
      },
    );

    expect(agent.name).toBe("researcher");
    expect(agent.tools.map((tool) => tool.name)).toEqual(["browser_snapshot"]);
  });

  test("runs snapshot agent through injected model runner", async () => {
    delete process.env.VULTURE_AGENT_MODE;
    const seenTools: string[][] = [];

    const events = await runAgent(
      {
        ...validRunParams,
        agent: {
          id: "browser-agent",
          name: "Browser Agent",
          instructions: "Use browser tools.",
          model: "gpt-5.4",
          tools: ["shell.exec", "browser.snapshot", "browser.click"],
        },
        workspace: {
          id: "vulture",
          path: "/Users/johnny/Work/vulture",
        },
      },
      () => ({
        request: async () => ({ ok: true }),
      }),
      {
        runModel: async (agent) => {
          seenTools.push(agent.tools.map((tool) => tool.name));
          return { finalOutput: "ok" };
        },
      },
    );

    expect(seenTools).toEqual([["shell_exec", "browser_snapshot", "browser_click"]]);
    expect(events.at(-1)?.payload).toEqual({ finalOutput: "ok" });
  });
});
