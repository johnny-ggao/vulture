import { tool } from "@openai/agents";
import { z } from "zod";

export type ToolGateway = {
  request(toolName: string, input: Record<string, unknown>): Promise<unknown>;
};

export const browserTabInput = z.object({ tabId: z.number().int().positive() });
export const browserClickInput = browserTabInput.extend({
  selector: z.string().min(1),
});

export async function requestBrowserSnapshot(
  gateway: ToolGateway,
  input: z.infer<typeof browserTabInput>,
) {
  return gateway.request("browser.snapshot", input);
}

export async function requestBrowserClick(
  gateway: ToolGateway,
  input: z.infer<typeof browserClickInput>,
) {
  return gateway.request("browser.click", input);
}

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

export function createBrowserTools(gateway: ToolGateway) {
  const snapshot = tool({
    name: "browser_snapshot",
    description: "Request a browser page snapshot through the Rust Browser Relay.",
    parameters: browserTabInput,
    execute: async (input) => requestBrowserSnapshot(gateway, input),
  });

  const click = tool({
    name: "browser_click",
    description: "Request a browser click through the Rust Browser Relay.",
    parameters: browserClickInput,
    execute: async (input) => requestBrowserClick(gateway, input),
  });

  return { snapshot, click };
}
