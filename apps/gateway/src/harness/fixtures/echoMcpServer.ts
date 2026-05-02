#!/usr/bin/env bun

/**
 * Minimal echo MCP server used by the acceptance harness to drive a real
 * stdio handshake. Spawned as a child process by the harness via the
 * gateway's "createMcpServer" route. Exposes a single "echo" tool that
 * returns the message it received.
 *
 * Stays intentionally tiny — the only contract this fixture ships is
 * "the gateway can list and call a real MCP tool over stdio." Any drift
 * in the underlying MCP protocol is caught by the acceptance scenario
 * that exercises this fixture.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

async function main(): Promise<void> {
  const server = new McpServer({
    name: "vulture-acceptance-echo",
    version: "0.1.0",
  });

  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Returns the provided message verbatim with an 'echo:' prefix.",
      inputSchema: { message: z.string() },
    },
    async ({ message }) => ({
      content: [{ type: "text", text: `echo: ${message}` }],
    }),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Self-terminate when stdin closes. The harness's deleteMcpServer step
  // closes the MCP transport on the gateway side, which closes our stdin —
  // without this listener the fixture would keep the parent test process
  // alive, hanging harness:ci after the suite returns.
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
}

void main();
