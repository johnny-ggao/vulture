import { Agent, run } from "@openai/agents";
import { makeEvent, RunCreateParams } from "@vulture/protocol";
import { createShellExecTool, type ToolGateway } from "./tools";

export type GatewayFactory = (runId: string) => ToolGateway;

export function createLocalWorkAgent(gateway: ToolGateway) {
  return new Agent({
    name: "local-work-agent",
    instructions:
      "You are Vulture's local work agent. Request local actions through tools and never claim a local command ran unless a tool result confirms it.",
    model: "gpt-5.4",
    tools: [createShellExecTool(gateway)],
  });
}

export async function runAgent(params: unknown, createGateway: GatewayFactory) {
  const parsed = RunCreateParams.parse(params);
  const runId = `run_${Date.now()}`;
  const gateway = createGateway(runId);

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

  const agent = createLocalWorkAgent(gateway);
  const result = await run(agent, parsed.input);

  return [
    makeEvent(runId, "run_started", { agentId: parsed.agentId }),
    makeEvent(runId, "run_completed", {
      finalOutput: result.finalOutput ? String(result.finalOutput) : "",
    }),
  ];
}
