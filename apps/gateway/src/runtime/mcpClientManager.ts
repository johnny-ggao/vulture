import { MCPServerStdio, tool, type MCPServer, type Tool } from "@openai/agents";
import type { ToolCallable } from "@vulture/agent-runtime";
import { isMcpToolEnabled, McpServerStore, type McpServerConfig } from "../domain/mcpServerStore";
import type { GatewayToolRunContext } from "../tools/sdkAdapter";

type McpTool = Awaited<ReturnType<MCPServer["listTools"]>>[number];

export const MCP_CLIENT_SESSION_TIMEOUT_SECONDS = 60;
export const MCP_TOOL_CALL_TIMEOUT_MS = 120_000;

export interface McpClientManagerOptions {
  createServer?: (config: McpServerConfig) => MCPServer;
}

export interface McpServerStatus {
  status: "connected" | "disconnected" | "failed";
  lastError: string | null;
  toolCount: number;
  updatedAt: string | null;
}

interface ConnectedServer {
  config: McpServerConfig;
  server: MCPServer;
  tools: McpTool[];
}

interface ToolBinding {
  config: McpServerConfig;
  server: MCPServer;
  mcpTool: McpTool;
  sdkName: string;
  internalName: string;
}

export class McpClientManager {
  private readonly createServer: (config: McpServerConfig) => MCPServer;
  private readonly connected = new Map<string, ConnectedServer>();
  private readonly statuses = new Map<string, McpServerStatus>();
  private readonly bindings = new Map<string, ToolBinding>();

  constructor(
    private readonly store: McpServerStore,
    opts: McpClientManagerOptions = {},
  ) {
    this.createServer = opts.createServer ?? createStdioServer;
  }

  status(serverId: string): McpServerStatus | undefined {
    return this.statuses.get(serverId);
  }

  async reconnect(serverId: string): Promise<void> {
    await this.disconnect(serverId);
    const config = this.store.get(serverId);
    if (!config || !config.enabled || config.trust === "disabled") {
      this.setStatus(serverId, "disconnected", null, 0);
      return;
    }
    await this.ensureConnected(config);
  }

  async listTools(serverId: string): Promise<Array<{ name: string; description?: string }>> {
    const config = this.store.get(serverId);
    if (!config || !config.enabled || config.trust === "disabled") return [];
    const connected = await this.ensureConnected(config);
    return connected?.tools.map((item) => ({
      name: item.name,
      description: item.description,
    })) ?? [];
  }

  async getSdkToolsForRun(): Promise<Tool<GatewayToolRunContext>[]> {
    const out: Tool<GatewayToolRunContext>[] = [];
    this.bindings.clear();
    for (const config of this.store.listLoadable()) {
      const connected = await this.ensureConnected(config);
      if (!connected) continue;
      for (const mcpTool of connected.tools) {
        if (!isMcpToolEnabled(config, mcpTool.name)) continue;
        const binding = this.makeBinding(config, connected.server, mcpTool);
        this.bindings.set(binding.sdkName, binding);
        out.push(this.toSdkTool(binding));
      }
    }
    return out;
  }

  canHandle(toolName: string): boolean {
    return this.bindings.has(toolName);
  }

  async executeToolCall(call: Parameters<ToolCallable>[0]): Promise<unknown> {
    const binding = this.bindings.get(call.tool);
    if (!binding) throw new Error(`unknown MCP tool: ${call.tool}`);
    const connected = await this.ensureConnected(binding.config);
    if (!connected) throw new Error(`MCP server unavailable: ${binding.config.id}`);
    return await connected.server.callTool(
      binding.mcpTool.name,
      sanitizeMcpArgs(coerceArgs(call.input), binding.mcpTool.inputSchema),
    );
  }

  async close(): Promise<void> {
    await Promise.all([...this.connected.keys()].map((id) => this.disconnect(id)));
  }

  private async ensureConnected(config: McpServerConfig): Promise<ConnectedServer | null> {
    const existing = this.connected.get(config.id);
    if (existing && existing.config.updatedAt === config.updatedAt) return existing;
    await this.disconnect(config.id);
    const server = this.createServer(config);
    try {
      await server.connect();
      const tools = await server.listTools();
      const connected = { config, server, tools };
      this.connected.set(config.id, connected);
      this.setStatus(config.id, "connected", null, tools.length);
      return connected;
    } catch (err) {
      await server.close().catch(() => undefined);
      this.setStatus(config.id, "failed", errorMessage(err), 0);
      return null;
    }
  }

  private async disconnect(serverId: string): Promise<void> {
    const existing = this.connected.get(serverId);
    this.connected.delete(serverId);
    for (const [sdkName, binding] of this.bindings) {
      if (binding.config.id === serverId) this.bindings.delete(sdkName);
    }
    if (existing) await existing.server.close().catch(() => undefined);
  }

  private makeBinding(config: McpServerConfig, server: MCPServer, mcpTool: McpTool): ToolBinding {
    const sdkName = `mcp_${slug(config.id)}_${slug(mcpTool.name)}`;
    return {
      config,
      server,
      mcpTool,
      sdkName,
      internalName: `mcp.${config.id}.${mcpTool.name}`,
    };
  }

  private toSdkTool(binding: ToolBinding): Tool<GatewayToolRunContext> {
    return tool({
      name: binding.sdkName,
      description: `[${binding.config.name}] ${binding.mcpTool.description ?? binding.mcpTool.name}`,
      parameters: normalizeMcpInputSchema(binding.mcpTool.inputSchema) as never,
      strict: true,
      needsApproval: async () => binding.config.trust !== "trusted",
      execute: async (input, context, details) => {
        const ctx = context?.context as GatewayToolRunContext | undefined;
        if (!ctx) throw new Error("McpClientManager: missing SdkRunContext");
        const callId = details?.toolCall?.callId ?? `mcp-${crypto.randomUUID()}`;
        const approvalToken = ctx.sdkApprovedToolCalls?.get(callId);
        ctx.onCheckpoint?.({
          sdkState: null,
          activeTool: {
            callId,
            tool: binding.internalName,
            input,
            approvalToken,
            idempotent: false,
          },
        });
        try {
          return await ctx.toolCallable({
            callId,
            tool: binding.sdkName,
            input,
            runId: ctx.runId,
            workspacePath: ctx.workspacePath,
            approvalToken,
          });
        } finally {
          ctx.onCheckpoint?.({ sdkState: null, activeTool: null });
        }
      },
    });
  }

  private setStatus(
    serverId: string,
    status: McpServerStatus["status"],
    lastError: string | null,
    toolCount: number,
  ): void {
    this.statuses.set(serverId, {
      status,
      lastError,
      toolCount,
      updatedAt: new Date().toISOString(),
    });
  }
}

function createStdioServer(config: McpServerConfig): MCPServer {
  return new MCPServerStdio({
    name: config.id,
    command: config.command,
    args: config.args,
    cwd: config.cwd ?? undefined,
    env: config.env,
    cacheToolsList: false,
    clientSessionTimeoutSeconds: MCP_CLIENT_SESSION_TIMEOUT_SECONDS,
    timeout: MCP_TOOL_CALL_TIMEOUT_MS,
  });
}

export function normalizeMcpInputSchema(input: unknown): Record<string, unknown> {
  const normalized = normalizeSchemaNode(input, false);
  const root = isRecord(normalized) ? normalized : {};
  const properties = isRecord(root.properties) ? root.properties : {};
  return {
    ...root,
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function normalizeSchemaNode(input: unknown, nullable: boolean): unknown {
  if (Array.isArray(input)) return input.map((item) => normalizeSchemaNode(item, false));
  if (!isRecord(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!isAllowedSchemaKey(key)) continue;
    if (key === "properties" && isRecord(value)) continue;
    if (key === "items") {
      out[key] = normalizeSchemaNode(value, false);
      continue;
    }
    out[key] = normalizeSchemaNode(value, false);
  }
  if (out.type === "object") {
    const sourceProperties = isRecord(input.properties) ? input.properties : {};
    const sourceRequired = new Set(
      Array.isArray(input.required)
        ? input.required.filter((value): value is string => typeof value === "string")
        : [],
    );
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(sourceProperties)) {
      properties[key] = normalizeSchemaNode(value, !sourceRequired.has(key));
    }
    out.properties = properties;
    out.required = Object.keys(properties);
    out.additionalProperties = false;
  }
  return nullable ? makeNullable(out) : out;
}

function makeNullable(schema: Record<string, unknown>): Record<string, unknown> {
  const out = { ...schema };
  if (Array.isArray(out.type)) {
    out.type = out.type.includes("null") ? out.type : [...out.type, "null"];
  } else if (typeof out.type === "string") {
    out.type = out.type === "null" ? "null" : [out.type, "null"];
  }
  if (Array.isArray(out.enum) && !out.enum.includes(null)) {
    out.enum = [...out.enum, null];
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isAllowedSchemaKey(key: string): boolean {
  return (
    key === "type" ||
    key === "description" ||
    key === "enum" ||
    key === "properties" ||
    key === "required" ||
    key === "additionalProperties" ||
    key === "items"
  );
}

function coerceArgs(input: unknown): Record<string, unknown> | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      return coerceArgs(parsed);
    } catch {
      return {};
    }
  }
  if (typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

export function sanitizeMcpArgs(input: Record<string, unknown> | null, schema: unknown): Record<string, unknown> | null {
  if (!input) return input;
  const sanitized = sanitizeSchemaObject(input, schema, false);
  return isRecord(sanitized) ? sanitized : {};
}

function sanitizeSchemaObject(input: unknown, schema: unknown, optional: boolean): unknown {
  if (input === null) return optional ? undefined : null;
  if (Array.isArray(input)) {
    const itemSchema = isRecord(schema) ? schema.items : undefined;
    return input
      .map((item) => sanitizeSchemaObject(item, itemSchema, false))
      .filter((item) => item !== undefined);
  }
  if (!isRecord(input) || !isRecord(schema) || schema.type !== "object") return input;

  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((value): value is string => typeof value === "string")
      : [],
  );
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const child = sanitizeSchemaObject(value, properties[key], !required.has(key));
    if (child !== undefined) out[key] = child;
  }
  return out;
}

function slug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "tool";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
