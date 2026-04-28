# L3a MCP Client Design

## Goal

Add a small, complete MCP client slice so Vulture agents can call tools from local MCP servers while staying aligned with the OpenAI Agents SDK.

The first slice should use the SDK's MCP integration instead of implementing the MCP protocol by hand. Vulture remains responsible for operator-facing configuration, persistence, approval policy, run timeline events, and failure isolation.

## Context

The current gateway already has a typed core tool registry, OpenAI Agents SDK tool adaptation, approval handling, durable run recovery, and Settings pages with an MCP placeholder.

The installed `@openai/agents` package exposes MCP primitives including:

- `MCPServerStdio`
- `MCPServerSSE`
- `MCPServerStreamableHttp`
- `connectMcpServers`
- `getAllMcpTools`
- `mcpToFunctionTool`
- `invalidateServerToolsCache`

This means the first MCP client implementation can delegate protocol negotiation, tool listing, and MCP tool invocation to the SDK. Vulture should not duplicate that protocol layer unless a product constraint requires it later.

## Scope

In scope:

- Configure local stdio MCP servers from Settings.
- Persist MCP server config per profile.
- Support `enabled`, `disabled`, and `trust` state.
- Start and connect enabled stdio MCP servers from the gateway.
- Surface MCP tools to Agents SDK runs alongside existing core tools.
- Default MCP tools to approval-required unless the server is explicitly trusted.
- Show MCP tool calls in the existing tool block UI.
- Keep gateway startup and runs resilient when an MCP server fails to start, list tools, or invoke a tool.
- Add focused tests for config persistence, tool discovery, run tool wiring, and failure handling.

Out of scope for this slice:

- Vulture as an MCP server.
- Remote MCP transports over SSE or streamable HTTP.
- Plugin marketplace, signed package distribution, import/export, or registry metadata.
- Per-tool trust editing UI.
- OAuth or secret-management flows for third-party hosted MCP servers.
- Long-running MCP process supervision beyond restart-on-demand and clear error state.

## Configuration Model

MCP servers are profile-level operator configuration. The first slice stores them in gateway SQLite so they survive app restarts and can be managed through HTTP routes.

Each server has:

```json
{
  "id": "filesystem-docs",
  "name": "Filesystem Docs",
  "transport": "stdio",
  "command": "bun",
  "args": ["run", "server.ts"],
  "cwd": "/absolute/path/or/null",
  "env": {
    "EXAMPLE": "value"
  },
  "trust": "ask",
  "enabled": true,
  "createdAt": 1777392000000,
  "updatedAt": 1777392000000
}
```

`transport` is stored even though only `stdio` is accepted in this slice. That keeps the schema additive for later SSE and streamable HTTP support.

Trust values:

- `trusted`: MCP tools may run under normal tool policy without an extra server-level prompt.
- `ask`: MCP tools require approval.
- `disabled`: server remains configured but is unavailable to agents.

`enabled: false` and `trust: "disabled"` both prevent the server from loading. `trust: "disabled"` is the stronger operator policy; `enabled` is a convenience switch.

## Gateway Routes

Add MCP management routes under `/v1/mcp/servers`:

- `GET /v1/mcp/servers`
- `POST /v1/mcp/servers`
- `PATCH /v1/mcp/servers/:id`
- `DELETE /v1/mcp/servers/:id`
- `POST /v1/mcp/servers/:id/reconnect`
- `GET /v1/mcp/servers/:id/tools`

The route output includes a derived runtime status:

```json
{
  "status": "disconnected",
  "lastError": "failed to start",
  "toolCount": 0,
  "updatedAt": 1777392000000
}
```

Runtime status is not authoritative configuration. It can be rebuilt after process restart.

## Runtime Integration

The gateway owns an `McpClientManager` with three responsibilities:

1. Load enabled stdio server configs from storage.
2. Create SDK `MCPServerStdio` instances and connect them.
3. Produce SDK tools for each run.

At run start:

1. Build existing core tools from `ToolRegistry`.
2. Ask `McpClientManager` for enabled MCP SDK tools.
3. Merge MCP tools after core tools.
4. Create the OpenAI Agents SDK `Agent` with the combined tool list.

MCP tool names should be namespaced when needed to avoid collisions with core tools. If the SDK exposes a stable MCP tool identity, use that identity. If not, Vulture should wrap the SDK-generated tool with a deterministic prefix:

```text
mcp_<serverSlug>_<toolName>
```

Core tools keep priority. A conflicting MCP tool must not replace a core tool.

## Approval And Audit

MCP servers default to `ask`.

For this slice, approval policy is server-level:

- `trust: "ask"`: every MCP tool invocation requires ApprovalCard confirmation.
- `trust: "trusted"`: invocation proceeds without the MCP-specific approval prompt.
- `trust: "disabled"`: tools are not exposed.

The existing tool timeline should display MCP calls with:

- source: `mcp`
- server id/name
- MCP tool name
- input
- output or error

If the SDK MCP tool cannot be directly wrapped with the existing `GatewayToolSpec`, Vulture should use a thin adapter that preserves SDK invocation while emitting the same checkpoints used by core tools.

## Settings UI

Replace the current MCP Settings stub with a management page.

Minimum UI:

- Server list with name, id, status, trust, enabled state, and tool count.
- Add server form for `name`, `command`, `args`, `cwd`, `env`, `trust`, and `enabled`.
- Edit server config.
- Delete server.
- Reconnect button.
- Tools preview for a server.
- Clear error state after successful reconnect.

This is an operator UI, not a consumer wizard. It can expose command, args, cwd, env, and trust directly, but it should validate obvious mistakes before saving.

## Error Handling

MCP failures must be isolated:

- Bad config should not prevent gateway startup.
- Failed server startup should mark only that server as `failed`.
- Tool list failure should show `toolCount: 0` and `lastError`.
- Tool invocation failure should become a normal tool error in the run timeline.
- Deleting or disabling a server should disconnect its SDK server instance.
- Reconnect should replace the current SDK server instance for that config.

The first implementation does not need persistent process logs. It should store the latest failure message and keep detailed logs in gateway logs.

## Security

MCP stdio servers execute local commands. They are operator-configured and should be treated as powerful local extensions.

Safety requirements:

- Only absolute `cwd` values are accepted when provided.
- `cwd` must exist and be a directory.
- `command` must be non-empty.
- `args` must be an array of strings.
- `env` values must be strings and should not be echoed in normal UI error messages.
- MCP defaults to `ask`.
- MCP tool calls are auditable like core tool calls.

Secrets should not be added to special storage in this slice. Operators can pass environment variables explicitly, but the UI must avoid displaying env values in tool call blocks or error details beyond the settings form itself.

## Testing

Add focused tests before or alongside implementation:

- Storage creates, updates, lists, and deletes MCP server configs.
- Invalid stdio config is rejected.
- Disabled or `trust: "disabled"` servers are not loaded.
- A fake stdio MCP server exposes a tool that appears in gateway tool discovery.
- MCP tool calls are wrapped with `source: "mcp"` timeline checkpoints.
- `trust: "ask"` requires approval and `trusted` does not.
- Failed server startup returns status data instead of throwing a route 500.
- Existing core tools still register and execute when an MCP server fails.

## Manual Verification

Use a simple local MCP server that exposes one harmless tool, for example `echo`.

Verify:

1. Add the server in Settings > MCP.
2. Confirm status becomes connected and tool count is non-zero.
3. Ask the agent to call the MCP echo tool.
4. Confirm an ApprovalCard appears when trust is `ask`.
5. Click allow and confirm the tool block remains visible with output.
6. Change trust to `trusted` and confirm the same tool call runs without MCP-specific approval.
7. Disable the server and confirm the agent no longer calls that tool.
8. Restart the app and confirm the server config persists.

## Acceptance Criteria

- Settings can manage stdio MCP server configs.
- Enabled stdio MCP servers expose tools to agent runs through the OpenAI Agents SDK MCP path.
- MCP tool calls show in the existing UI tool blocks.
- MCP server trust controls approval behavior.
- Broken MCP servers do not break gateway startup, normal chat, core tools, or Settings.
- Existing Skill, Memory, attachments, token usage, approvals, and run recovery behavior remain unchanged.
