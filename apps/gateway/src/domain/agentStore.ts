import {
  mkdirSync,
  existsSync,
  statSync,
  readdirSync,
  renameSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, parse } from "node:path";
import { brandId } from "@vulture/common";
import type { DB } from "../persistence/sqlite";
import type {
  Agent,
  AgentId,
  AgentToolPreset,
  AgentToolName,
  ReasoningLevel,
  SaveAgentRequest,
} from "@vulture/protocol/src/v1/agent";
import { AGENT_TOOL_NAMES, AGENT_TOOL_PRESETS } from "@vulture/protocol/src/v1/agent";
import type {
  SaveWorkspaceRequest,
  Workspace,
  WorkspaceId,
} from "@vulture/protocol/src/v1/workspace";
import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";

interface AgentRow {
  id: string;
  name: string;
  description: string;
  model: string;
  reasoning: string;
  tools: string;
  tool_preset?: string | null;
  tool_include_json?: string | null;
  tool_exclude_json?: string | null;
  skills?: string | null;
  handoff_agent_ids_json?: string | null;
  workspace_json: string;
  instructions: string;
  avatar?: string | null;
  created_at: string;
  updated_at: string;
}

export const AGENT_CORE_FILE_NAMES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
  "MEMORY.md",
  "tool-registry.jsonc",
  "skills/skills.jsonc",
] as const;

export type AgentCoreFileName = (typeof AGENT_CORE_FILE_NAMES)[number];

export interface AgentCoreFile {
  name: AgentCoreFileName;
  path: string;
  missing: boolean;
  size?: number;
  updatedAtMs?: number;
  content?: string;
}

const PRESET_GENERAL_INSTRUCTIONS = [
  "You are Vulture, a local-first general assistant.",
  "Complete the user's task directly; do not stall with standby phrases.",
  "Inspect files and run tools to ground your answers — never claim a local action ran unless a tool result confirms it.",
  "For workspace questions, read the directory before summarizing.",
  "When the user is exploring an idea, ask focused clarifying questions before committing to an answer.",
].join(" ");

const PRESET_CODING_INSTRUCTIONS = [
  "You are Vulture Coding, an engineering partner working inside a code repository.",
  "Always read before editing; never invent APIs, file paths, or function signatures — confirm with the read or search tools first.",
  "Prefer small, focused changes over sweeping rewrites; respect existing patterns in the repo.",
  "Verify your work with builds, tests, or type-checks before claiming a change is complete.",
  "When fixing bugs, find the root cause; do not paper over symptoms.",
  "For risky operations (destructive shell, dependency changes, force pushes), surface the plan before executing.",
].join(" ");

const PRESET_GENERAL: Readonly<SaveAgentRequest> = Object.freeze({
  id: "local-work-agent",
  name: "Vulture",
  description: "通用助手——日常工作、写作、研究、问答",
  model: "gpt-5.4",
  reasoning: "medium",
  toolPreset: "full",
  toolInclude: [],
  toolExclude: [],
  tools: [...AGENT_TOOL_NAMES],
  handoffAgentIds: [],
  avatar: "compass",
  instructions: PRESET_GENERAL_INSTRUCTIONS,
});

const PRESET_CODING: Readonly<SaveAgentRequest> = Object.freeze({
  id: "coding-agent",
  name: "Vulture Coding",
  description: "工程伙伴——面向代码仓库的开发与验证",
  model: "gpt-5.4",
  reasoning: "high",
  toolPreset: "full",
  toolInclude: [],
  toolExclude: [],
  tools: [...AGENT_TOOL_NAMES],
  handoffAgentIds: [],
  avatar: "circuit",
  instructions: PRESET_CODING_INSTRUCTIONS,
});

const DEFAULT_AGENTS: readonly Readonly<SaveAgentRequest>[] = Object.freeze([
  PRESET_GENERAL,
  PRESET_CODING,
]);

function rowToAgent(r: AgentRow): Agent {
  const workspace_data = JSON.parse(r.workspace_json);
  const storedTools = parseToolArrayJson(r.tools);
  const toolPolicy = normalizeStoredToolPolicy(
    r.tool_preset,
    r.tool_include_json,
    r.tool_exclude_json,
    storedTools,
  );
  return {
    id: brandId<AgentId>(r.id),
    name: r.name,
    description: r.description,
    model: r.model,
    reasoning: r.reasoning as ReasoningLevel,
    tools: toolPolicy.tools,
    toolPreset: toolPolicy.toolPreset,
    toolInclude: toolPolicy.toolInclude,
    toolExclude: toolPolicy.toolExclude,
    skills: parseSkillsJson(r.skills),
    handoffAgentIds: parseStringArrayJson(r.handoff_agent_ids_json),
    workspace: {
      id: brandId<WorkspaceId>(workspace_data.id),
      name: workspace_data.name,
      path: workspace_data.path,
      createdAt: workspace_data.createdAt as Iso8601,
      updatedAt: workspace_data.updatedAt as Iso8601,
    } as Workspace,
    instructions: r.instructions,
    avatar: r.avatar ?? undefined,
    createdAt: r.created_at as Iso8601,
    updatedAt: r.updated_at as Iso8601,
  };
}

export class AgentStore {
  constructor(
    private readonly db: DB,
    private readonly profileDir: string,
    private readonly defaultWorkspacePath?: string,
    private readonly privateWorkspaceHomeDir: string = homedir(),
  ) {}

  list(): Agent[] {
    this.ensureDefaults();
    const rows = this.db.query("SELECT * FROM agents ORDER BY name ASC").all() as AgentRow[];
    return rows.map(rowToAgent);
  }

  get(id: string): Agent | null {
    this.ensureDefaults();
    const row = this.db.query("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | undefined;
    return row ? rowToAgent(row) : null;
  }

  save(req: SaveAgentRequest): Agent {
    this.ensureDefaults();
    return this._save(req);
  }

  delete(id: string): void {
    this.ensureDefaults();
    const remaining = (
      this.db.query("SELECT COUNT(*) AS c FROM agents").get() as { c: number }
    ).c;
    if (remaining <= 1) {
      throw new Error("cannot delete the last agent");
    }
    this.db.query("DELETE FROM agents WHERE id = ?").run(id);
  }

  agentRootPath(id: string): string {
    const agent = this.get(id);
    if (!agent) throw new Error(`agent not found: ${id}`);
    return this.agentRootPathFor(agent);
  }

  isUsingPrivateWorkspace(id: string): boolean {
    this.ensureDefaults();
    const agent = this.get(id);
    if (!agent) return false;
    return this.isManagedPrivateWorkspace(id, agent.workspace as Workspace);
  }

  agentCorePath(id: string): string {
    return join(this.agentRootPath(id), "agent-core");
  }

  listAgentCoreFiles(id: string): AgentCoreFile[] {
    const corePath = this.agentCorePath(id);
    return AGENT_CORE_FILE_NAMES.map((name) => this.agentCoreFileMeta(corePath, name));
  }

  readAgentCoreFile(id: string, name: string): AgentCoreFile {
    const fileName = normalizeAgentCoreFileName(name);
    const corePath = this.agentCorePath(id);
    const meta = this.agentCoreFileMeta(corePath, fileName);
    return {
      ...meta,
      content: meta.missing ? "" : readFileSync(meta.path, "utf8"),
    };
  }

  writeAgentCoreFile(id: string, name: string, content: string): AgentCoreFile {
    const fileName = normalizeAgentCoreFileName(name);
    const corePath = this.agentCorePath(id);
    const filePath = join(corePath, fileName);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, "utf8");
    const meta = this.agentCoreFileMeta(corePath, fileName);
    return { ...meta, content };
  }

  private ensureDefaults(): void {
    for (const preset of DEFAULT_AGENTS) {
      const existingRow = this.db
        .query("SELECT * FROM agents WHERE id = ?")
        .get(preset.id) as AgentRow | undefined;
      if (!existingRow) {
        this._save(preset);
      }
    }
    // Migration / reconcile passes still run on every call.
    // ensurePresetFieldsCurrent unconditionally rewrites tools / tool_preset /
    // tool_include_json / tool_exclude_json, so a separate "tools-current"
    // reconcile pass would be dead code.
    this.ensureLegacyPrivateWorkspacesCurrent();
    this.ensureDefaultWorkspaceCurrent();
    this.ensureAgentLayoutsCurrent();
    this.ensurePresetFieldsCurrent();
  }

  private ensureLegacyPrivateWorkspacesCurrent(): void {
    const rows = this.db.query("SELECT * FROM agents").all() as AgentRow[];
    for (const row of rows) {
      const agent = rowToAgent(row);
      const workspace = agent.workspace as Workspace;
      if (
        !this.isLegacyPrivateWorkspace(row.id, workspace.path) &&
        !this.isOutdatedManagedPrivateWorkspace(row.id, row.name, workspace)
      ) {
        continue;
      }
      const migrated = this.migrateLegacyPrivateWorkspace(row.id, row.name, workspace);
      if (migrated.path === workspace.path) continue;
      this.db
        .query("UPDATE agents SET workspace_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(migrated), nowIso8601(), row.id);
    }
  }

  private _save(req: SaveAgentRequest): Agent {
    const now = nowIso8601();
    const existingRow = this.db.query("SELECT * FROM agents WHERE id = ?").get(req.id) as AgentRow | undefined;
    const existing = existingRow ? rowToAgent(existingRow) : undefined;
    const workspace = this.ensureAgentWorkspace(
      req.id,
      req.name,
      existing?.workspace as Workspace | undefined,
      req.workspace,
    );
    const toolPolicy = toolPolicyFromSaveRequest(req);
    this.ensureAgentCoreFiles({ ...req, ...toolPolicy }, workspace);
    // `avatar` is opaque to the gateway — the client owns the
    // preset registry. Only the empty string is normalised to NULL
    // so the column never holds a sentinel.
    const avatarValue =
      typeof req.avatar === "string" && req.avatar.trim() !== ""
        ? req.avatar.trim()
        : existing?.avatar ?? null;
    if (existing) {
      this.db
        .query(
          "UPDATE agents SET name=?, description=?, model=?, reasoning=?, tools=?, tool_preset=?, tool_include_json=?, tool_exclude_json=?, skills=?, handoff_agent_ids_json=?, workspace_json=?, instructions=?, avatar=?, updated_at=? WHERE id=?",
        )
        .run(
          req.name,
          req.description,
          req.model,
          req.reasoning,
          JSON.stringify(toolPolicy.tools),
          toolPolicy.toolPreset,
          JSON.stringify(toolPolicy.toolInclude),
          JSON.stringify(toolPolicy.toolExclude),
          req.skills === undefined ? null : JSON.stringify(req.skills),
          JSON.stringify(req.handoffAgentIds ?? []),
          JSON.stringify(workspace),
          req.instructions,
          avatarValue,
          now,
          req.id,
        );
    } else {
      this.db
        .query(
          `INSERT INTO agents(id, name, description, model, reasoning, tools, tool_preset, tool_include_json, tool_exclude_json, skills, handoff_agent_ids_json, workspace_json, instructions, avatar, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          req.id,
          req.name,
          req.description,
          req.model,
          req.reasoning,
          JSON.stringify(toolPolicy.tools),
          toolPolicy.toolPreset,
          JSON.stringify(toolPolicy.toolInclude),
          JSON.stringify(toolPolicy.toolExclude),
          req.skills === undefined ? null : JSON.stringify(req.skills),
          JSON.stringify(req.handoffAgentIds ?? []),
          JSON.stringify(workspace),
          req.instructions,
          avatarValue,
          now,
          now,
        );
    }
    const savedRow = this.db.query("SELECT * FROM agents WHERE id = ?").get(req.id) as AgentRow;
    return rowToAgent(savedRow);
  }

  private ensureAgentWorkspace(
    agentId: string,
    agentName: string,
    existing?: Workspace,
    requested?: SaveWorkspaceRequest,
  ): Workspace {
    if (requested) {
      return this.workspaceFromRequest(requested, existing);
    }
    if (existing && this.isLegacyPrivateWorkspace(agentId, existing.path)) {
      return this.migrateLegacyPrivateWorkspace(agentId, agentName, existing);
    }
    if (existing && existsSync(existing.path) && statSync(existing.path).isDirectory()) {
      return existing;
    }
    const defaultWorkspace = this.defaultWorkspaceFor(agentId);
    if (defaultWorkspace) {
      return defaultWorkspace;
    }
    return this.createPrivateWorkspace(agentId, agentName, existing);
  }

  private migrateLegacyPrivateWorkspace(
    agentId: string,
    agentName: string,
    existing: Workspace,
  ): Workspace {
    const desiredRoot = this.privateWorkspacePath(agentId, agentName);
    const desiredProjectPath = this.privateProjectPath(agentId, agentName);
    if (existing.path === desiredProjectPath) {
      this.ensureAgentCoreFilesForValues({
        id: agentId,
        name: agentName,
        description: "",
        model: "",
        reasoning: "medium",
        tools: [],
        toolPreset: "none",
        toolInclude: [],
        toolExclude: [],
        skills: undefined,
        handoffAgentIds: [],
        instructions: "",
      }, existing);
      return existing;
    }

    if (existsSync(existing.path) && statSync(existing.path).isDirectory()) {
      mkdirSync(desiredRoot, { recursive: true });
      mkdirSync(desiredProjectPath, { recursive: true });
      if (existing.path === desiredRoot) {
        this.moveWorkspaceEntriesIntoProject(desiredRoot, desiredProjectPath);
      } else if (existsSync(desiredProjectPath)) {
        if (!statSync(desiredProjectPath).isDirectory()) {
          throw new Error(`private workspace project path is not a directory: ${desiredProjectPath}`);
        }
        if (readdirSync(desiredProjectPath).length === 0) {
          rmSync(desiredProjectPath, { recursive: true, force: true });
          renameSync(existing.path, desiredProjectPath);
        } else {
          this.mergeWorkspaceDirectories(existing.path, desiredProjectPath);
        }
      } else {
        renameSync(existing.path, desiredProjectPath);
      }
    } else {
      mkdirSync(desiredProjectPath, { recursive: true });
    }

    const migrated = {
      ...existing,
      path: desiredProjectPath,
      updatedAt: nowIso8601(),
    };
    this.ensureAgentCoreFilesForValues({
      id: agentId,
      name: agentName,
      description: "",
      model: "",
      reasoning: "medium",
      tools: [],
      toolPreset: "none",
      toolInclude: [],
      toolExclude: [],
      skills: undefined,
      handoffAgentIds: [],
      instructions: "",
    }, migrated);
    return migrated;
  }

  private mergeWorkspaceDirectories(sourcePath: string, targetPath: string): void {
    for (const entry of readdirSync(sourcePath)) {
      const from = join(sourcePath, entry);
      let to = join(targetPath, entry);
      if (existsSync(to)) {
        const parsed = parse(entry);
        to = join(targetPath, `${parsed.name}.legacy-${Date.now()}${parsed.ext}`);
      }
      renameSync(from, to);
    }
    rmSync(sourcePath, { recursive: true, force: true });
  }

  private createPrivateWorkspace(
    agentId: string,
    agentName: string,
    existing?: Workspace,
  ): Workspace {
    const root = this.privateWorkspacePath(agentId, agentName);
    const path = this.privateProjectPath(agentId, agentName);
    mkdirSync(join(root, "agent-core"), { recursive: true });
    mkdirSync(path, { recursive: true });
    const now = nowIso8601();
    return {
      id: existing?.id ?? brandId<WorkspaceId>(`${agentId}-workspace`),
      name: existing?.name ?? `${agentName} Workspace`,
      path,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  private ensureDefaultWorkspaceCurrent(): void {
    for (const preset of DEFAULT_AGENTS) {
      const existingRow = this.db
        .query("SELECT * FROM agents WHERE id = ?")
        .get(preset.id) as AgentRow | undefined;
      if (!existingRow) continue;
      const existing = rowToAgent(existingRow).workspace as Workspace;
      let desired = this.defaultWorkspaceFor(preset.id, existing);
      let replacingManagedDefaultWorkspace = false;
      if (!desired) {
        if (this.isLegacyPrivateWorkspace(preset.id, existing.path)) {
          desired = this.migrateLegacyPrivateWorkspace(preset.id, preset.name, existing);
        } else if (this.isManagedPrivateWorkspace(preset.id, existing)) {
          desired = this.createPrivateWorkspace(preset.id, preset.name, existing);
          replacingManagedDefaultWorkspace = true;
        } else {
          continue;
        }
      }
      if (existing.path === desired.path) continue;
      if (
        !replacingManagedDefaultWorkspace &&
        !this.isEmptyPrivateWorkspace(preset.id, preset.name, existing.path)
      ) {
        continue;
      }
      this.db
        .query("UPDATE agents SET workspace_json = ?, updated_at = ? WHERE id = ?")
        .run(JSON.stringify(desired), nowIso8601(), preset.id);
    }
  }

  private workspaceFromRequest(
    requested: SaveWorkspaceRequest,
    existing?: Workspace,
  ): Workspace {
    if (!existsSync(requested.path) || !statSync(requested.path).isDirectory()) {
      throw new Error(`workspace path is not a directory: ${requested.path}`);
    }
    const now = nowIso8601();
    const workspace = {
      id: brandId<WorkspaceId>(requested.id),
      name: requested.name,
      path: requested.path,
      createdAt: existing?.id === requested.id ? existing.createdAt : now,
      updatedAt: now,
    };
    mkdirSync(join(requested.path, "agent-core"), { recursive: true });
    return workspace;
  }

  private defaultWorkspaceFor(agentId: string, existing?: Workspace): Workspace | null {
    if (agentId !== PRESET_GENERAL.id) return null;
    const path = this.defaultWorkspacePath;
    if (!path || !existsSync(path) || !statSync(path).isDirectory()) return null;
    const now = nowIso8601();
    return {
      id: existing?.id ?? brandId<WorkspaceId>(`${agentId}-workspace`),
      name: existing?.name ?? `${basename(path)} Workspace`,
      path,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  private privateWorkspacePath(agentId: string, agentName: string): string {
    return privateWorkspacePathForAgent(this.privateWorkspaceHomeDir, agentId, agentName);
  }

  private privateProjectPath(agentId: string, agentName: string): string {
    return join(this.privateWorkspacePath(agentId, agentName), "project");
  }

  private privateWorkspaceRoot(): string {
    return join(this.privateWorkspaceHomeDir, ".vuture", "workspace");
  }

  private legacyPrivateWorkspacePath(agentId: string): string {
    return join(this.profileDir, "agents", agentId, "workspace");
  }

  private isLegacyPrivateWorkspace(agentId: string, path: string): boolean {
    return path === this.legacyPrivateWorkspacePath(agentId);
  }

  private isManagedPrivateWorkspace(agentId: string, workspace: Workspace): boolean {
    return workspace.id === brandId<WorkspaceId>(`${agentId}-workspace`);
  }

  private isOutdatedManagedPrivateWorkspace(
    agentId: string,
    agentName: string,
    workspace: Workspace,
  ): boolean {
    return (
      this.isManagedPrivateWorkspace(agentId, workspace) &&
      (
        dirname(workspace.path) === this.privateWorkspaceRoot() ||
        dirname(dirname(workspace.path)) === this.privateWorkspaceRoot()
      ) &&
      workspace.path !== this.privateProjectPath(agentId, agentName)
    );
  }

  private isEmptyPrivateWorkspace(agentId: string, agentName: string, path: string): boolean {
    if (
      path !== this.privateWorkspacePath(agentId, agentName) &&
      path !== this.privateProjectPath(agentId, agentName) &&
      path !== this.legacyPrivateWorkspacePath(agentId)
    ) {
      return false;
    }
    if (!existsSync(path) || !statSync(path).isDirectory()) return true;
    return readdirSync(path).length === 0;
  }

  private ensurePresetFieldsCurrent(): void {
    for (const preset of DEFAULT_AGENTS) {
      const existingRow = this.db
        .query("SELECT * FROM agents WHERE id = ?")
        .get(preset.id) as AgentRow | undefined;
      if (!existingRow) continue;
      const policy = toolPolicyFromSaveRequest(preset);
      this.db
        .query(
          `UPDATE agents SET
            name=?, description=?, model=?, reasoning=?,
            tools=?, tool_preset=?, tool_include_json=?, tool_exclude_json=?,
            skills=?, handoff_agent_ids_json=?,
            instructions=?, avatar=?, updated_at=?
           WHERE id=?`,
        )
        .run(
          preset.name,
          preset.description,
          preset.model,
          preset.reasoning,
          JSON.stringify(policy.tools),
          policy.toolPreset,
          JSON.stringify(policy.toolInclude),
          JSON.stringify(policy.toolExclude),
          preset.skills === undefined ? null : JSON.stringify(preset.skills),
          JSON.stringify(preset.handoffAgentIds ?? []),
          preset.instructions,
          preset.avatar ?? null,
          nowIso8601(),
          preset.id,
        );
    }
  }

  private ensureAgentLayoutsCurrent(): void {
    const rows = this.db.query("SELECT * FROM agents").all() as AgentRow[];
    for (const row of rows) {
      const agent = rowToAgent(row);
      this.ensureAgentCoreFilesForValues(agent, agent.workspace as Workspace);
    }
  }

  private ensureAgentCoreFiles(req: SaveAgentRequest, workspace: Workspace): void {
    this.ensureAgentCoreFilesForValues(req, workspace);
  }

  private ensureAgentCoreFilesForValues(
    agent: Pick<SaveAgentRequest, "id" | "name" | "description" | "model" | "reasoning" | "tools" | "instructions"> & {
      toolPreset?: AgentToolPreset;
      toolInclude?: AgentToolName[];
      toolExclude?: AgentToolName[];
      skills?: string[];
      handoffAgentIds?: string[];
    },
    workspace: Workspace,
  ): void {
    const root = this.agentRootPathForWorkspace(workspace);
    const corePath = join(root, "agent-core");
    mkdirSync(join(corePath, "skills"), { recursive: true });
    const templates = agentCoreTemplates(agent, workspace);
    for (const [name, content] of Object.entries(templates) as Array<[AgentCoreFileName, string]>) {
      const filePath = join(corePath, name);
      mkdirSync(dirname(filePath), { recursive: true });
      if (!existsSync(filePath)) {
        writeFileSync(filePath, content, "utf8");
      }
    }
  }

  private agentRootPathFor(agent: Agent): string {
    return this.agentRootPathForWorkspace(agent.workspace as Workspace);
  }

  private agentRootPathForWorkspace(workspace: Workspace): string {
    if (
      basename(workspace.path) === "project" &&
      dirname(dirname(workspace.path)) === this.privateWorkspaceRoot()
    ) {
      return dirname(workspace.path);
    }
    return workspace.path;
  }

  private agentCoreFileMeta(corePath: string, name: AgentCoreFileName): AgentCoreFile {
    const path = join(corePath, name);
    if (!existsSync(path) || !statSync(path).isFile()) {
      return { name, path, missing: true };
    }
    const stat = statSync(path);
    return { name, path, missing: false, size: stat.size, updatedAtMs: Math.floor(stat.mtimeMs) };
  }

  private moveWorkspaceEntriesIntoProject(root: string, projectPath: string): void {
    for (const entry of readdirSync(root)) {
      if (entry === "agent-core" || entry === "project") continue;
      let to = join(projectPath, entry);
      if (existsSync(to)) {
        const parsed = parse(entry);
        to = join(projectPath, `${parsed.name}.legacy-${Date.now()}${parsed.ext}`);
      }
      renameSync(join(root, entry), to);
    }
  }

}

export function privateWorkspacePathForAgent(
  homeDir: string,
  agentId: string,
  agentName: string,
): string {
  return join(homeDir, ".vuture", "workspace", privateWorkspaceDirName(agentId, agentName));
}

function privateWorkspaceDirName(agentId: string, agentName: string): string {
  const normalized = agentName
    .trim()
    .toLowerCase()
    .replace(/[\\/:"*?<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^\.+$/, "")
    .replace(/^\.\.+/, "")
    .trim();
  return normalized.length > 0 && /[\p{L}\p{N}]/u.test(normalized) ? normalized : agentId.toLowerCase();
}

function parseSkillsJson(raw: string | null | undefined): string[] | undefined {
  if (raw === null || raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : undefined;
  } catch {
    return undefined;
  }
}

function parseStringArrayJson(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

interface ToolPolicy {
  tools: AgentToolName[];
  toolPreset: AgentToolPreset;
  toolInclude: AgentToolName[];
  toolExclude: AgentToolName[];
}

function toolPolicyFromSaveRequest(req: SaveAgentRequest): ToolPolicy {
  if (req.toolPreset === undefined) {
    return deriveToolPolicyFromTools(req.tools);
  }
  const toolInclude = uniqueTools(req.toolInclude ?? []);
  const toolExclude = uniqueTools(req.toolExclude ?? []);
  return {
    toolPreset: req.toolPreset,
    toolInclude,
    toolExclude,
    tools: expandToolPolicy(req.toolPreset, toolInclude, toolExclude),
  };
}

function normalizeStoredToolPolicy(
  rawPreset: string | null | undefined,
  rawInclude: string | null | undefined,
  rawExclude: string | null | undefined,
  storedTools: readonly AgentToolName[],
): ToolPolicy {
  const toolPreset = isAgentToolPreset(rawPreset) ? rawPreset : "none";
  const toolInclude = parseToolArrayJson(rawInclude);
  const toolExclude = parseToolArrayJson(rawExclude);
  const hasStoredPolicy =
    rawPreset !== undefined &&
    rawPreset !== null &&
    (toolPreset !== "none" || toolInclude.length > 0 || toolExclude.length > 0 || storedTools.length === 0);
  if (!hasStoredPolicy && storedTools.length > 0) {
    return deriveToolPolicyFromTools(storedTools);
  }
  return {
    toolPreset,
    toolInclude,
    toolExclude,
    tools: expandToolPolicy(toolPreset, toolInclude, toolExclude),
  };
}

function deriveToolPolicyFromTools(tools: readonly AgentToolName[]): ToolPolicy {
  const normalized = uniqueTools(tools);
  const exact = matchingToolPreset(normalized);
  if (exact) {
    return {
      tools: [...AGENT_TOOL_PRESETS[exact]],
      toolPreset: exact,
      toolInclude: [],
      toolExclude: [],
    };
  }
  return {
    tools: normalized,
    toolPreset: "none",
    toolInclude: normalized,
    toolExclude: [],
  };
}

function expandToolPolicy(
  preset: AgentToolPreset,
  include: readonly AgentToolName[],
  exclude: readonly AgentToolName[],
): AgentToolName[] {
  const excluded = new Set(exclude);
  return uniqueTools([...AGENT_TOOL_PRESETS[preset], ...include]).filter((tool) => !excluded.has(tool));
}

function parseToolArrayJson(raw: string | null | undefined): AgentToolName[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? uniqueTools(parsed.filter((value): value is AgentToolName => isAgentToolName(value)))
      : [];
  } catch {
    return [];
  }
}

function uniqueTools(tools: readonly AgentToolName[]): AgentToolName[] {
  const seen = new Set<AgentToolName>();
  const result: AgentToolName[] = [];
  for (const tool of tools) {
    if (!seen.has(tool)) {
      seen.add(tool);
      result.push(tool);
    }
  }
  return result;
}

function matchingToolPreset(tools: readonly AgentToolName[]): AgentToolPreset | null {
  for (const preset of ["none", "minimal", "standard", "developer", "tl", "full"] as const) {
    if (sameToolSet(tools, AGENT_TOOL_PRESETS[preset])) return preset;
  }
  return null;
}

function sameToolSet(left: readonly AgentToolName[], right: readonly AgentToolName[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((tool) => rightSet.has(tool));
}

function isAgentToolName(value: unknown): value is AgentToolName {
  return typeof value === "string" && (AGENT_TOOL_NAMES as readonly string[]).includes(value);
}

function isAgentToolPreset(value: unknown): value is AgentToolPreset {
  return (
    value === "none" ||
    value === "minimal" ||
    value === "standard" ||
    value === "developer" ||
    value === "tl" ||
    value === "full"
  );
}

function normalizeAgentCoreFileName(name: string): AgentCoreFileName {
  const normalized = name.trim().replace(/\\/g, "/");
  if ((AGENT_CORE_FILE_NAMES as readonly string[]).includes(normalized)) {
    return normalized as AgentCoreFileName;
  }
  throw new Error(`unsupported agent core file: ${name}`);
}

function agentCoreTemplates(
  agent: Pick<SaveAgentRequest, "id" | "name" | "description" | "model" | "reasoning" | "tools" | "instructions"> & {
    toolPreset?: AgentToolPreset;
    toolInclude?: AgentToolName[];
    toolExclude?: AgentToolName[];
    skills?: string[];
    handoffAgentIds?: string[];
  },
  workspace: Workspace,
): Record<AgentCoreFileName, string> {
  const skillPolicy = agent.skills === undefined ? "all" : agent.skills.length === 0 ? "none" : "allowlist";
  const toolPolicy = normalizeStoredToolPolicy(
    agent.toolPreset,
    JSON.stringify(agent.toolInclude ?? []),
    JSON.stringify(agent.toolExclude ?? []),
    agent.tools,
  );
  return {
    "AGENTS.md": [
      "# AGENTS.md",
      "",
      "## Agent Rules",
      agent.instructions.trim() || "Complete the user's task directly and carefully.",
      "",
      "## Working Directory",
      `Use the project workspace at \`${workspace.path}\` for local file and tool work.`,
      "",
    ].join("\n"),
    "SOUL.md": [
      "# SOUL.md",
      "",
      `You are ${agent.name}.`,
      "",
      agent.description.trim() || "Be helpful, clear, and pragmatic.",
      "",
      "Prefer concise answers, but include enough detail for the task to be actionable.",
      "",
    ].join("\n"),
    "TOOLS.md": [
      "# TOOLS.md",
      "",
      "Tool availability is generated from `tool-registry.jsonc` and the saved agent tool policy.",
      "",
      "Add local environment notes below when a tool needs agent-specific context.",
      "",
    ].join("\n"),
    "IDENTITY.md": agent.id === "coding-agent"
      ? [
          "# Identity",
          "",
          "You are Vulture Coding, the engineering counterpart of Vulture.",
          "",
          "## Working principles",
          "- Test-driven when feasible: write the failing test first, then the implementation.",
          "- Small files, small functions; high cohesion, low coupling.",
          "- Immutable data flow; no in-place mutation of arguments.",
          "- Validate inputs at boundaries; trust internal contracts.",
          "- When in doubt, read the code rather than guess.",
          "",
          "## Plan before executing (mandatory for non-trivial changes)",
          "Any change that touches more than ~5 lines, more than one file, or",
          "any test/build flow MUST go through this loop:",
          "1. Restate the user's request in your own words. Resolve ambiguity by asking, not assuming.",
          "2. Call the `update_plan` tool with the concrete steps you intend to take (one item per discrete edit / verification).",
          "3. Wait for the user's explicit go-ahead before making code changes. \"OK / 继续 / go\" is enough; silence is not consent.",
          "4. Execute one plan item at a time. Mark it complete in `update_plan` before moving on.",
          "Trivial work — typo fixes, single-line tweaks, pure questions — may skip the plan, but say so explicitly when you do.",
          "",
          "## Verify before claiming completion (mandatory)",
          "After ANY edit / write / apply_patch, you MUST verify before saying \"done\", \"fixed\", \"passing\", or similar:",
          "- Run the relevant test or typecheck command via `shell.exec` (e.g. `bun test path/to/file.test.ts`, `bun run typecheck`, `cargo check`, `cargo test`).",
          "- Read the actual output. Don't claim success on \"exit code 0\" alone — find the line that says \"X passed\" / \"no errors\".",
          "- If you ran a partial verification (one test file out of the suite), say so explicitly. Partial verification is not full verification.",
          "- If you cannot run the verification (missing toolchain, sandboxed shell denied), tell the user that and ask how to proceed; do NOT declare done.",
          "Forbidden phrases without verification: \"this should work\", \"the build will pass now\", \"I think this fixes it\".",
          "",
          "## Risky operations require an explicit plan",
          "Destructive shell (rm -rf, force push, dropping tables, killing processes), dependency upgrades / additions, and migrations all need to appear in `update_plan` first so the user can veto. Surface the exact command + working directory before invoking it.",
          "",
        ].join("\n")
      : [
          "# IDENTITY.md",
          "",
          `- **Name:** ${agent.name}`,
          `- **Role:** ${agent.description.trim() || "Vulture agent"}`,
          "",
        ].join("\n"),
    "USER.md": agent.id === "coding-agent" || agent.id === "local-work-agent"
      ? [
          "# User Preferences",
          "",
          "- Default language: 中文 (Chinese). Switch to English only when the user writes in English.",
          "- Style: concise, no filler greetings, no trailing summaries when the diff or output already speaks for itself.",
          "",
        ].join("\n")
      : [
          "# USER.md",
          "",
          "Capture durable user preferences here when the user explicitly asks you to remember them.",
          "",
        ].join("\n"),
    "HEARTBEAT.md": "",
    "BOOTSTRAP.md": [
      "# BOOTSTRAP.md",
      "",
      "On first start, read `USER.md`, `IDENTITY.md`, `SOUL.md`, and `TOOLS.md`, then greet the user briefly.",
      "",
      "After setup is complete, this file can be left alone or removed by a future onboarding flow.",
      "",
    ].join("\n"),
    "MEMORY.md": "",
    "tool-registry.jsonc": `${JSON.stringify(
      {
        version: 1,
        preset: toolPolicy.toolPreset,
        builtin: {
          include: toolPolicy.toolInclude,
          exclude: toolPolicy.toolExclude,
        },
        mcp: [],
        conditional: [],
        notes: "",
      },
      null,
      2,
    )}\n`,
    "skills/skills.jsonc": `${JSON.stringify(
      {
        version: 1,
        policy: skillPolicy,
        allowlist: agent.skills ?? null,
        skills: [],
      },
      null,
      2,
    )}\n`,
  };
}
