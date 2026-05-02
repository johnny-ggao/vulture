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

export type SkillCatalogSource = "local" | "remote" | "manual";
export type SkillLifecycleStatus = "not_installed" | "installed" | "outdated" | "failed";

export interface SkillCatalogEntry {
  name: string;
  description: string;
  version: string;
  source: SkillCatalogSource;
  packagePath?: string;
  homepage?: string;
  installed: boolean;
  installedVersion: string | null;
  installedAt: string | null;
  needsUpdate: boolean;
  lifecycleStatus: SkillLifecycleStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SkillCatalogResponse {
  items: SkillCatalogEntry[];
}

export interface ImportSkillCatalogInput {
  packagePath: string;
  source?: SkillCatalogSource;
  homepage?: string;
}

export const skillsApi = {
  list: (client: ApiClient, agentId: string) =>
    client.get<SkillListResponse>(`/v1/skills?agentId=${encodeURIComponent(agentId)}`),
  listCatalog: (client: ApiClient) =>
    client.get<SkillCatalogResponse>("/v1/skill-catalog"),
  importCatalogPackage: (client: ApiClient, input: ImportSkillCatalogInput) =>
    client.post<SkillCatalogEntry>("/v1/skill-catalog/import", input),
  installCatalogEntry: (client: ApiClient, name: string) =>
    client.post<SkillCatalogEntry>(`/v1/skill-catalog/${encodeURIComponent(name)}/install`, {}),
  updateCatalog: (client: ApiClient) =>
    client.post<SkillCatalogResponse>("/v1/skill-catalog/update-all", {}),
};
