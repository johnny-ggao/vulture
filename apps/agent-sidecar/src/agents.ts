import { Agent, run } from "@openai/agents";
import { AgentRunConfig, makeEvent, RunCreateParams } from "@vulture/protocol";
import { createBrowserTools, createShellExecTool, type ToolGateway } from "./tools";

export type GatewayFactory = (runId: string) => ToolGateway;
export type RunModel = (
  agent: Agent,
  input: string,
) => Promise<{ finalOutput?: unknown }>;

export type RunAgentOptions = {
  runModel?: RunModel;
};

export function createAgentFromConfig(config: unknown, gateway: ToolGateway) {
  const parsed = AgentRunConfig.parse(config);
  const browserTools = createBrowserTools(gateway);
  const tools = [];

  if (parsed.tools.includes("shell.exec")) {
    tools.push(createShellExecTool(gateway));
  }
  if (parsed.tools.includes("browser.snapshot")) {
    tools.push(browserTools.snapshot);
  }
  if (parsed.tools.includes("browser.click")) {
    tools.push(browserTools.click);
  }

  return new Agent({
    name: parsed.id,
    instructions: parsed.instructions,
    model: parsed.model,
    tools,
  });
}

export function createLocalWorkAgent(gateway: ToolGateway) {
  return createAgentFromConfig(
    {
      id: "local-work-agent",
      name: "Local Work Agent",
      instructions:
        "You are Vulture's local work agent. Request local actions through tools and never claim a local command ran unless a tool result confirms it.",
      model: "gpt-5.4",
      tools: ["shell.exec", "browser.snapshot", "browser.click"],
    },
    gateway,
  );
}

export async function runAgent(
  params: unknown,
  createGateway: GatewayFactory,
  options: RunAgentOptions = {},
) {
  const parsed = RunCreateParams.parse(params);
  const runId = `run_${Date.now()}`;
  const gateway = createGateway(runId);
  const runModel = options.runModel ?? ((agent, input) => run(agent, input));

  if (process.env.VULTURE_AGENT_MODE === "mock") {
    if (process.env.VULTURE_MOCK_TOOL_REQUEST === "1") {
      await gateway.request("shell.exec", {
        cwd: "/tmp",
        argv: ["pwd"],
        timeoutMs: 120000,
      });
    }

    return [
      makeEvent(runId, "run_started", { agentId: parsed.agentId }),
      makeEvent(runId, "model_delta", { text: `Mock response for: ${parsed.input}` }),
      makeEvent(runId, "run_completed", { finalOutput: "Mock run completed" }),
    ];
  }

  const agent = parsed.agent
    ? createAgentFromConfig(parsed.agent, gateway)
    : createLocalWorkAgent(gateway);
  const result = await runModel(agent, parsed.input);

  return [
    makeEvent(runId, "run_started", { agentId: parsed.agentId }),
    makeEvent(runId, "run_completed", {
      finalOutput: result.finalOutput ? String(result.finalOutput) : "",
    }),
  ];
}
