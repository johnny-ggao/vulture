import { Hono } from "hono";
import { loadSkillEntries, type SkillEntry } from "../runtime/skills";

export interface SkillListItem {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: "builtin" | "profile" | "workspace" | "agent-core";
  modelInvocationEnabled: boolean;
  userInvocable: boolean;
}

export interface SkillListResponse {
  items: SkillListItem[];
}

export function skillsRouter(profileDir: string): Hono {
  const app = new Hono();

  app.get("/v1/skills", (c) => {
    const items = loadSkillEntries({ profileDir }).map(toListItem);
    const body: SkillListResponse = { items };
    return c.json(body);
  });

  return app;
}

function toListItem(entry: SkillEntry): SkillListItem {
  return {
    name: entry.name,
    description: entry.description,
    filePath: entry.filePath,
    baseDir: entry.baseDir,
    source: entry.source ?? "workspace",
    modelInvocationEnabled: entry.modelInvocationEnabled,
    userInvocable: entry.userInvocable ?? true,
  };
}
