import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { DB } from "../persistence/sqlite";
import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";

export type McpTransport = "stdio";
export type McpTrust = "trusted" | "ask" | "disabled";

export interface McpServerConfig {
  id: string;
  profileId: string;
  name: string;
  transport: McpTransport;
  command: string;
  args: string[];
  cwd: string | null;
  env: Record<string, string>;
  trust: McpTrust;
  enabled: boolean;
  enabledTools: string[] | null;
  disabledTools: string[];
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

export interface SaveMcpServerConfig {
  id: string;
  profileId?: string;
  name: string;
  transport: McpTransport;
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  trust?: McpTrust;
  enabled?: boolean;
  enabledTools?: string[] | null;
  disabledTools?: string[];
}

export interface UpdateMcpServerConfig {
  name?: string;
  command?: string;
  args?: string[];
  cwd?: string | null;
  env?: Record<string, string>;
  trust?: McpTrust;
  enabled?: boolean;
  enabledTools?: string[] | null;
  disabledTools?: string[];
}

interface McpServerRow {
  id: string;
  profile_id: string;
  name: string;
  transport: string;
  command: string;
  args_json: string;
  cwd: string | null;
  env_json: string;
  trust: string;
  enabled: number;
  enabled_tools_json: string | null;
  disabled_tools_json: string;
  created_at: string;
  updated_at: string;
}

const DEFAULT_PROFILE_ID = "default";
const TRUST_VALUES = new Set<McpTrust>(["trusted", "ask", "disabled"]);

export class McpServerStore {
  constructor(private readonly db: DB) {}

  list(profileId = DEFAULT_PROFILE_ID): McpServerConfig[] {
    const rows = this.db
      .query("SELECT * FROM mcp_servers WHERE profile_id = ? ORDER BY updated_at DESC, name ASC")
      .all(profileId) as McpServerRow[];
    return rows.map(rowToConfig);
  }

  listLoadable(profileId = DEFAULT_PROFILE_ID): McpServerConfig[] {
    return this.list(profileId).filter((server) => server.enabled && server.trust !== "disabled");
  }

  get(id: string, profileId = DEFAULT_PROFILE_ID): McpServerConfig | null {
    const row = this.db
      .query("SELECT * FROM mcp_servers WHERE id = ? AND profile_id = ?")
      .get(id, profileId) as McpServerRow | undefined;
    return row ? rowToConfig(row) : null;
  }

  create(input: SaveMcpServerConfig): McpServerConfig {
    const value = validateCreate(input);
    const now = nowIso8601();
    this.db
      .query(
        `INSERT INTO mcp_servers(
          id, profile_id, name, transport, command, args_json, cwd, env_json,
          trust, enabled, created_at, updated_at, enabled_tools_json, disabled_tools_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.id,
        value.profileId,
        value.name,
        value.transport,
        value.command,
        JSON.stringify(value.args),
        value.cwd,
        JSON.stringify(value.env),
        value.trust,
        value.enabled ? 1 : 0,
        now,
        now,
        value.enabledTools === null ? null : JSON.stringify(value.enabledTools),
        JSON.stringify(value.disabledTools),
      );
    return this.get(value.id, value.profileId)!;
  }

  update(id: string, patch: UpdateMcpServerConfig, profileId = DEFAULT_PROFILE_ID): McpServerConfig {
    const existing = this.get(id, profileId);
    if (!existing) throw new Error(`mcp server not found: ${id}`);
    const merged = validateCreate({
      ...existing,
      ...patch,
      id: existing.id,
      profileId: existing.profileId,
      transport: existing.transport,
    });
    const now = nowIso8601();
    this.db
      .query(
        `UPDATE mcp_servers
         SET name = ?, command = ?, args_json = ?, cwd = ?, env_json = ?,
             trust = ?, enabled = ?, enabled_tools_json = ?, disabled_tools_json = ?, updated_at = ?
         WHERE id = ? AND profile_id = ?`,
      )
      .run(
        merged.name,
        merged.command,
        JSON.stringify(merged.args),
        merged.cwd,
        JSON.stringify(merged.env),
        merged.trust,
        merged.enabled ? 1 : 0,
        merged.enabledTools === null ? null : JSON.stringify(merged.enabledTools),
        JSON.stringify(merged.disabledTools),
        now,
        id,
        profileId,
      );
    return this.get(id, profileId)!;
  }

  delete(id: string, profileId = DEFAULT_PROFILE_ID): void {
    this.db.query("DELETE FROM mcp_servers WHERE id = ? AND profile_id = ?").run(id, profileId);
  }
}

function validateCreate(input: SaveMcpServerConfig): Omit<McpServerConfig, "createdAt" | "updatedAt"> {
  const id = input.id.trim();
  if (!id) throw new Error("id is required");
  const profileId = (input.profileId ?? DEFAULT_PROFILE_ID).trim();
  if (!profileId) throw new Error("profileId is required");
  const name = input.name.trim();
  if (!name) throw new Error("name is required");
  if (input.transport !== "stdio") throw new Error("transport must be stdio");
  const command = input.command.trim();
  if (!command) throw new Error("command is required");
  const args = input.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error("args must be strings");
  }
  const cwd = input.cwd ?? null;
  if (cwd !== null) {
    if (!isAbsolute(cwd)) throw new Error("cwd must be absolute");
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error("cwd must be an existing directory");
    }
  }
  const env = input.env ?? {};
  for (const [key, value] of Object.entries(env)) {
    if (!key || typeof value !== "string") throw new Error("env values must be strings");
  }
  const trust = input.trust ?? "ask";
  if (!TRUST_VALUES.has(trust)) throw new Error("trust is invalid");
  const enabledTools = validateToolList(input.enabledTools ?? null, "enabledTools", true);
  const disabledTools = validateToolList(input.disabledTools ?? [], "disabledTools", false) ?? [];
  return {
    id,
    profileId,
    name,
    transport: "stdio",
    command,
    args,
    cwd,
    env,
    trust,
    enabled: input.enabled ?? true,
    enabledTools,
    disabledTools,
  };
}

function rowToConfig(row: McpServerRow): McpServerConfig {
  return {
    id: row.id,
    profileId: row.profile_id,
    name: row.name,
    transport: "stdio",
    command: row.command,
    args: parseStringArray(row.args_json),
    cwd: row.cwd,
    env: parseStringRecord(row.env_json),
    trust: TRUST_VALUES.has(row.trust as McpTrust) ? (row.trust as McpTrust) : "ask",
    enabled: row.enabled === 1,
    enabledTools: row.enabled_tools_json === null ? null : parseStringArray(row.enabled_tools_json),
    disabledTools: parseStringArray(row.disabled_tools_json),
    createdAt: row.created_at as Iso8601,
    updatedAt: row.updated_at as Iso8601,
  };
}

export function isMcpToolEnabled(
  server: Pick<McpServerConfig, "enabledTools" | "disabledTools">,
  toolName: string,
): boolean {
  if (server.disabledTools.includes(toolName)) return false;
  if (server.enabledTools !== null && !server.enabledTools.includes(toolName)) return false;
  return true;
}

function validateToolList(
  value: string[] | null,
  field: string,
  nullable: boolean,
): string[] | null {
  if (value === null) {
    if (nullable) return null;
    throw new Error(`${field} must be strings`);
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${field} must be strings`);
  }
  return [...new Set(value.map((item) => item.trim()).filter(Boolean))];
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

function parseStringRecord(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}
