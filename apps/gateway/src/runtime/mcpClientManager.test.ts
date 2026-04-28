import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunContext } from "@openai/agents";
import type { MCPServer } from "@openai/agents";
import type { ToolCallable } from "@vulture/agent-runtime";
import { openDatabase } from "../persistence/sqlite";
import { applyMigrations } from "../persistence/migrate";
import { McpServerStore } from "../domain/mcpServerStore";
import { McpClientManager } from "./mcpClientManager";
import { normalizeMcpInputSchema } from "./mcpClientManager";
import { sanitizeMcpArgs } from "./mcpClientManager";
import type { GatewayToolRunContext } from "../tools/sdkAdapter";

type McpTool = Awaited<ReturnType<MCPServer["listTools"]>>[number];

type TestFunctionTool = {
  name: string;
  needsApproval: (
    context: RunContext<GatewayToolRunContext>,
    input: unknown,
    callId?: string,
  ) => Promise<boolean>;
  invoke: (
    context: RunContext<GatewayToolRunContext>,
    input: string,
    details?: { toolCall?: { callId?: string } },
  ) => Promise<unknown>;
};

class FakeMcpServer implements MCPServer {
  cacheToolsList = false;
  readonly calls: Array<{ toolName: string; args: Record<string, unknown> | null }> = [];
  connected = false;
  constructor(
    readonly name: string,
    private readonly tools: McpTool[],
    private readonly failConnect = false,
  ) {}

  async connect(): Promise<void> {
    if (this.failConnect) throw new Error("failed");
    this.connected = true;
  }

  async close(): Promise<void> {
    this.connected = false;
  }

  async listTools(): Promise<McpTool[]> {
    return this.tools;
  }

  async callTool(toolName: string, args: Record<string, unknown> | null) {
    this.calls.push({ toolName, args });
    return [{ type: "text" as const, text: JSON.stringify({ toolName, args }) }];
  }

  async invalidateToolsCache(): Promise<void> {}
}

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "vulture-mcp-manager-"));
  const cwd = join(dir, "server");
  mkdirSync(cwd);
  const db = openDatabase(join(dir, "data.sqlite"));
  applyMigrations(db);
  return {
    dir,
    cwd,
    store: new McpServerStore(db),
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true });
    },
  };
}

function echoTool(): McpTool {
  return {
    name: "echo",
    description: "Echo input",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
  };
}

function namedTool(name: string): McpTool {
  return {
    ...echoTool(),
    name,
    description: `${name} input`,
  };
}

function readTextFileTool(): McpTool {
  return {
    name: "read_text_file",
    description: "Read text file",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        tail: { type: "number" },
        head: { type: "number" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  };
}

describe("McpClientManager", () => {
  test("exposes connected MCP tools as namespaced SDK tools", async () => {
    const { store, cleanup } = freshStore();
    store.create({
      id: "echo-server",
      name: "Echo Server",
      transport: "stdio",
      command: "bun",
      args: [],
      cwd: null,
      env: {},
      trust: "ask",
      enabled: true,
    });
    const server = new FakeMcpServer("echo-server", [echoTool()]);
    const manager = new McpClientManager(store, { createServer: () => server });

    const tools = await manager.getSdkToolsForRun();

    expect(tools.map((tool) => tool.name)).toEqual(["mcp_echo_server_echo"]);
    expect(manager.status("echo-server")?.status).toBe("connected");
    expect(manager.status("echo-server")?.toolCount).toBe(1);
    cleanup();
  });

  test("does not expose disabled servers", async () => {
    const { store, cleanup } = freshStore();
    store.create({
      id: "off",
      name: "Off",
      transport: "stdio",
      command: "bun",
      args: [],
      cwd: null,
      env: {},
      trust: "ask",
      enabled: false,
    });
    const manager = new McpClientManager(store, {
      createServer: () => new FakeMcpServer("off", [echoTool()]),
    });

    expect(await manager.getSdkToolsForRun()).toEqual([]);
    cleanup();
  });

  test("filters MCP tools by server tool visibility policy", async () => {
    const { store, cleanup } = freshStore();
    store.create({
      id: "official-filesystem",
      name: "Official Filesystem",
      transport: "stdio",
      command: "npx",
      args: [],
      cwd: null,
      env: {},
      trust: "trusted",
      enabled: true,
      enabledTools: ["list_directory", "read_text_file"],
      disabledTools: ["read_text_file"],
    });
    const manager = new McpClientManager(store, {
      createServer: () =>
        new FakeMcpServer("official-filesystem", [
          namedTool("list_directory"),
          namedTool("read_text_file"),
          namedTool("write_file"),
        ]),
    });

    const tools = await manager.getSdkToolsForRun();

    expect(tools.map((tool) => tool.name)).toEqual([
      "mcp_official_filesystem_list_directory",
    ]);
    expect(manager.status("official-filesystem")?.toolCount).toBe(3);
    cleanup();
  });

  test("records failed server status without throwing", async () => {
    const { store, cleanup } = freshStore();
    store.create({
      id: "bad",
      name: "Bad",
      transport: "stdio",
      command: "bun",
      args: [],
      cwd: null,
      env: {},
      trust: "ask",
      enabled: true,
    });
    const manager = new McpClientManager(store, {
      createServer: () => new FakeMcpServer("bad", [echoTool()], true),
    });

    expect(await manager.getSdkToolsForRun()).toEqual([]);
    expect(manager.status("bad")?.status).toBe("failed");
    expect(manager.status("bad")?.lastError).toContain("failed");
    cleanup();
  });

  test("uses trust to control SDK approval", async () => {
    const { store, cleanup } = freshStore();
    store.create({
      id: "trusted",
      name: "Trusted",
      transport: "stdio",
      command: "bun",
      args: [],
      cwd: null,
      env: {},
      trust: "trusted",
      enabled: true,
    });
    const manager = new McpClientManager(store, {
      createServer: () => new FakeMcpServer("trusted", [echoTool()]),
    });
    const [tool] = (await manager.getSdkToolsForRun()) as unknown as TestFunctionTool[];

    const needsApproval = await tool.needsApproval(
      new RunContext({
        runId: "r",
        workspacePath: "/tmp/work",
        toolCallable: async () => "ok",
        sdkApprovedToolCalls: new Map(),
      }),
      { text: "hi" },
      "c1",
    );

    expect(needsApproval).toBe(false);
    cleanup();
  });

  test("SDK tool execution flows through toolCallable and manager invoke", async () => {
    const { store, cleanup } = freshStore();
    store.create({
      id: "echo-server",
      name: "Echo Server",
      transport: "stdio",
      command: "bun",
      args: [],
      cwd: null,
      env: {},
      trust: "ask",
      enabled: true,
    });
    const server = new FakeMcpServer("echo-server", [echoTool()]);
    const manager = new McpClientManager(store, { createServer: () => server });
    const [tool] = (await manager.getSdkToolsForRun()) as unknown as TestFunctionTool[];
    const checkpoints: unknown[] = [];
    const toolCallable: ToolCallable = async (call) => manager.executeToolCall(call);

    const result = await tool.invoke(
      new RunContext({
        runId: "r-test",
        workspacePath: "/tmp/work",
        sdkApprovedToolCalls: new Map([["c1", "sdk-approved-c1"]]),
        toolCallable,
        onCheckpoint: (checkpoint) => checkpoints.push(checkpoint),
      }),
      JSON.stringify({ text: "hello" }),
      { toolCall: { callId: "c1" } },
    );

    expect(server.calls).toEqual([{ toolName: "echo", args: { text: "hello" } }]);
    expect(result).toEqual([{ type: "text", text: JSON.stringify({ toolName: "echo", args: { text: "hello" } }) }]);
    expect(checkpoints[0]).toMatchObject({
      activeTool: {
        callId: "c1",
        tool: "mcp.echo-server.echo",
        approvalToken: "sdk-approved-c1",
      },
    });
    expect(checkpoints.at(-1)).toEqual({ sdkState: null, activeTool: null });
    cleanup();
  });

  test("drops null optional parameters before invoking the MCP server", async () => {
    const { store, cleanup } = freshStore();
    store.create({
      id: "official-filesystem",
      name: "Official Filesystem",
      transport: "stdio",
      command: "npx",
      args: [],
      cwd: null,
      env: {},
      trust: "trusted",
      enabled: true,
    });
    const server = new FakeMcpServer("official-filesystem", [readTextFileTool()]);
    const manager = new McpClientManager(store, { createServer: () => server });
    const [tool] = (await manager.getSdkToolsForRun()) as unknown as TestFunctionTool[];
    const toolCallable: ToolCallable = async (call) => manager.executeToolCall(call);

    await tool.invoke(
      new RunContext({
        runId: "r-test",
        workspacePath: "/tmp/work",
        sdkApprovedToolCalls: new Map(),
        toolCallable,
      }),
      JSON.stringify({ path: "/tmp/hello.txt", tail: null, head: null }),
      { toolCall: { callId: "c1" } },
    );

    expect(server.calls).toEqual([
      { toolName: "read_text_file", args: { path: "/tmp/hello.txt" } },
    ]);
    cleanup();
  });
});

describe("normalizeMcpInputSchema", () => {
  test("removes draft metadata and defaults while preserving useful argument shape", () => {
    expect(
      normalizeMcpInputSchema({
        type: "object",
        $schema: "http://json-schema.org/draft-07/schema#",
        properties: {
          path: { type: "string" },
          options: {
            type: "object",
            properties: {
              sortBy: { type: "string", enum: ["name", "size"], default: "name" },
            },
          },
          excludePatterns: {
            type: "array",
            default: [],
            items: { type: "string" },
          },
        },
        required: ["path"],
      }),
    ).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
        options: {
          type: ["object", "null"],
          properties: {
            sortBy: { type: ["string", "null"], enum: ["name", "size", null] },
          },
          required: ["sortBy"],
          additionalProperties: false,
        },
        excludePatterns: {
          type: ["array", "null"],
          items: { type: "string" },
        },
      },
      required: ["path", "options", "excludePatterns"],
      additionalProperties: false,
    });
  });

  test("makes optional filesystem parameters nullable and required for strict mode", () => {
    expect(
      normalizeMcpInputSchema({
        type: "object",
        properties: {
          path: { type: "string" },
          tail: { type: "number" },
          head: { type: "number" },
        },
        required: ["path"],
      }),
    ).toEqual({
      type: "object",
      properties: {
        path: { type: "string" },
        tail: { type: ["number", "null"] },
        head: { type: ["number", "null"] },
      },
      required: ["path", "tail", "head"],
      additionalProperties: false,
    });
  });

  test("drops validation keywords outside the conservative OpenAI tool schema subset", () => {
    expect(
      normalizeMcpInputSchema({
        type: "object",
        properties: {
          paths: {
            type: "array",
            minItems: 1,
            items: {
              type: "string",
              pattern: ".*",
            },
          },
        },
        required: ["paths"],
      }),
    ).toEqual({
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["paths"],
      additionalProperties: false,
    });
  });
});

describe("sanitizeMcpArgs", () => {
  test("removes nulls only for optional properties from the original MCP schema", () => {
    expect(
      sanitizeMcpArgs(
        {
          path: "/tmp/hello.txt",
          tail: null,
          head: 0,
          options: { mode: null, requiredValue: null },
        },
        {
          type: "object",
          properties: {
            path: { type: "string" },
            tail: { type: "number" },
            head: { type: "number" },
            options: {
              type: "object",
              properties: {
                mode: { type: "string" },
                requiredValue: { type: "string" },
              },
              required: ["requiredValue"],
            },
          },
          required: ["path", "options"],
        },
      ),
    ).toEqual({
      path: "/tmp/hello.txt",
      head: 0,
      options: { requiredValue: null },
    });
  });
});
