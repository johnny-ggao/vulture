import { Hono } from "hono";
import { AgentStore } from "../domain/agentStore";
import { loadSkillEntries, type SkillEntry } from "../runtime/skills";

export interface SkillListItem {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: "builtin" | "profile" | "workspace" | "agent-core";
  modelInvocationEnabled: boolean;
  userInvocable: boolean;
  enabled: boolean;
}

export interface SkillListResponse {
  agentId: string;
  policy: "all" | "none" | "allowlist";
  allowlist?: string[];
  items: SkillListItem[];
}

export function skillsRouter(agentStore: AgentStore, profileDir: string): Hono {
  const app = new Hono();

  app.get("/v1/skills", (c) => {
    const agentId = c.req.query("agentId");
    if (!agentId) {
      return c.json({ code: "skill.agent_required", message: "agentId is required" }, 400);
    }

    const agent = agentStore.get(agentId);
    if (!agent) {
      return c.json({ code: "agent.not_found", message: agentId }, 404);
    }

    const allowlist = agent.skills;
    const enabled = enabledPredicate(allowlist);
    const items = loadSkillEntries({
      workspaceDir: agent.workspace.path,
      profileDir,
      agentCoreDir: agentStore.agentCorePath(agent.id),
    }).map((entry) => toListItem(entry, enabled(entry.name)));

    const body: SkillListResponse = {
      agentId,
      policy: allowlist === undefined ? "all" : allowlist.length === 0 ? "none" : "allowlist",
      allowlist: allowlist === undefined ? undefined : [...allowlist],
      items,
    };
    return c.json(body);
  });

  return app;
}

function enabledPredicate(allowlist: readonly string[] | undefined): (name: string) => boolean {
  if (allowlist === undefined) return () => true;
  const allowed = new Set(allowlist);
  if (allowed.size === 0) return () => false;
  return (name) => allowed.has(name);
}

function toListItem(entry: SkillEntry, enabled: boolean): SkillListItem {
  return {
    name: entry.name,
    description: entry.description,
    filePath: entry.filePath,
    baseDir: entry.baseDir,
    source: entry.source ?? "workspace",
    modelInvocationEnabled: entry.modelInvocationEnabled,
    userInvocable: entry.userInvocable ?? true,
    enabled,
  };
}
