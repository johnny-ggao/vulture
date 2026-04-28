import type { ApiClient } from "./client";

export type SkillPolicy = "all" | "none" | "allowlist";

export interface SkillListItem {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  source: "profile" | "workspace";
  modelInvocationEnabled: boolean;
  userInvocable: boolean;
  enabled: boolean;
}

export interface SkillListResponse {
  agentId: string;
  policy: SkillPolicy;
  allowlist?: string[];
  items: SkillListItem[];
}

export const skillsApi = {
  list: (client: ApiClient, agentId: string) =>
    client.get<SkillListResponse>(`/v1/skills?agentId=${encodeURIComponent(agentId)}`),
};
