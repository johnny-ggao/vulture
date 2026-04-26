import { tool } from "@openai/agents";
import { z } from "zod";

export type ToolGateway = {
  request(toolName: string, input: Record<string, unknown>): Promise<unknown>;
};

export function createShellExecTool(gateway: ToolGateway) {
  return tool({
    name: "shell_exec",
    description: "Request a local shell command through the Rust Tool Gateway.",
    parameters: z.object({
      cwd: z.string(),
      argv: z.array(z.string()).min(1),
      timeoutMs: z.number().int().positive().default(120000),
    }),
    execute: async (input) => {
      return gateway.request("shell.exec", input);
    },
  });
}
