import { nowIso8601, type Iso8601 } from "@vulture/protocol/src/v1/index";
import { readJsonFile, writeJsonFile } from "./jsonFileStore";

export type PermissionPolicyAction = "allow" | "ask" | "deny";
export type PermissionPolicyScope = "global" | "agent";

export interface PermissionPolicyRule {
  id: string;
  scope: PermissionPolicyScope;
  agentId: string | null;
  toolId: string | null;
  category: string | null;
  commandPrefix: string | null;
  action: PermissionPolicyAction;
  enabled: boolean;
  reason: string | null;
  createdAt: Iso8601;
  updatedAt: Iso8601;
}

export interface SavePermissionPolicyRuleInput {
  id?: string;
  scope?: PermissionPolicyScope;
  agentId?: string | null;
  toolId?: string | null;
  category?: string | null;
  commandPrefix?: string | null;
  action: PermissionPolicyAction;
  enabled?: boolean;
  reason?: string | null;
}

export interface ExplainPermissionPolicyInput {
  agentId?: string | null;
  toolId?: string | null;
  category?: string | null;
  command?: string | null;
}

export interface PermissionPolicyDecision {
  action: PermissionPolicyAction;
  matchedRule: PermissionPolicyRule | null;
  reason: string;
}

interface PolicyFile {
  schemaVersion: 1;
  rules: PermissionPolicyRule[];
}

const EMPTY_POLICY: PolicyFile = { schemaVersion: 1, rules: [] };

export class PermissionPolicyStore {
  constructor(private readonly path: string) {}

  list(): PermissionPolicyRule[] {
    return this.read().rules.slice().sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  upsert(input: SavePermissionPolicyRuleInput): PermissionPolicyRule {
    const now = nowIso8601();
    const file = this.read();
    const id = input.id?.trim() || `perm-${crypto.randomUUID()}`;
    const existingIndex = file.rules.findIndex((rule) => rule.id === id);
    const existing = existingIndex >= 0 ? file.rules[existingIndex] : null;
    const next = normalizeRule({
      ...existing,
      ...input,
      id,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    if (existingIndex >= 0) file.rules[existingIndex] = next;
    else file.rules.push(next);
    this.write(file);
    return next;
  }

  delete(id: string): boolean {
    const file = this.read();
    const next = file.rules.filter((rule) => rule.id !== id);
    if (next.length === file.rules.length) return false;
    this.write({ schemaVersion: 1, rules: next });
    return true;
  }

  explain(input: ExplainPermissionPolicyInput): PermissionPolicyDecision {
    const match = this.list()
      .filter((rule) => rule.enabled)
      .find((rule) => matchesRule(rule, input));
    if (!match) {
      return {
        action: "ask",
        matchedRule: null,
        reason: "No permission policy matched; defaulting to ask.",
      };
    }
    return {
      action: match.action,
      matchedRule: match,
      reason: match.reason ?? `Matched permission policy ${match.id}.`,
    };
  }

  private read(): PolicyFile {
    const parsed = readJsonFile<PolicyFile>(this.path, EMPTY_POLICY);
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.rules)) return EMPTY_POLICY;
    return { schemaVersion: 1, rules: parsed.rules.filter(isRule) };
  }

  private write(file: PolicyFile): void {
    writeJsonFile(this.path, file);
  }
}

function normalizeRule(input: SavePermissionPolicyRuleInput & Pick<PermissionPolicyRule, "id" | "createdAt" | "updatedAt">): PermissionPolicyRule {
  if (!isAction(input.action)) throw new Error("action is invalid");
  const scope = input.scope ?? (input.agentId ? "agent" : "global");
  if (scope !== "global" && scope !== "agent") throw new Error("scope is invalid");
  const agentId = input.agentId?.trim() || null;
  if (scope === "agent" && !agentId) throw new Error("agentId is required for agent scope");
  const toolId = input.toolId?.trim() || null;
  const category = input.category?.trim() || null;
  const commandPrefix = input.commandPrefix?.trim() || null;
  if (!toolId && !category && !commandPrefix) {
    throw new Error("at least one matcher is required");
  }
  return {
    id: input.id,
    scope,
    agentId: scope === "agent" ? agentId : null,
    toolId,
    category,
    commandPrefix,
    action: input.action,
    enabled: input.enabled ?? true,
    reason: input.reason?.trim() || null,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };
}

function matchesRule(rule: PermissionPolicyRule, input: ExplainPermissionPolicyInput): boolean {
  if (rule.scope === "agent" && rule.agentId !== (input.agentId ?? null)) return false;
  if (rule.toolId && rule.toolId !== (input.toolId ?? null)) return false;
  if (rule.category && rule.category !== (input.category ?? null)) return false;
  if (rule.commandPrefix) {
    const command = input.command ?? "";
    if (!command.startsWith(rule.commandPrefix)) return false;
  }
  return true;
}

function isRule(value: unknown): value is PermissionPolicyRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as Partial<PermissionPolicyRule>;
  return (
    typeof rule.id === "string" &&
    (rule.scope === "global" || rule.scope === "agent") &&
    (typeof rule.agentId === "string" || rule.agentId === null) &&
    (typeof rule.toolId === "string" || rule.toolId === null) &&
    (typeof rule.category === "string" || rule.category === null) &&
    (typeof rule.commandPrefix === "string" || rule.commandPrefix === null) &&
    isAction(rule.action) &&
    typeof rule.enabled === "boolean" &&
    (typeof rule.reason === "string" || rule.reason === null) &&
    typeof rule.createdAt === "string" &&
    typeof rule.updatedAt === "string"
  );
}

function isAction(value: unknown): value is PermissionPolicyAction {
  return value === "allow" || value === "ask" || value === "deny";
}
