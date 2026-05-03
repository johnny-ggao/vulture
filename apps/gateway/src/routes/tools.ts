import { Hono } from "hono";
import { createCoreToolRegistry } from "../tools/coreTools";
import type { GatewayToolCategory, GatewayToolRisk, GatewayToolSource } from "../tools/types";

export interface ToolCatalogItem {
  id: string;
  label: string;
  description: string;
  source: GatewayToolSource;
  category: GatewayToolCategory;
  risk: GatewayToolRisk;
  idempotent: boolean;
  sdkName: string;
}

export interface ToolCatalogGroup {
  id: GatewayToolCategory;
  label: string;
  items: ToolCatalogItem[];
}

export interface ToolCatalogResponse {
  groups: ToolCatalogGroup[];
}

const CATEGORY_LABELS: Record<GatewayToolCategory, string> = {
  fs: "Files",
  workspace: "Workspace",
  runtime: "Runtime",
  web: "Web",
  sessions: "Sessions",
  agents: "Agents",
  memory: "Memory",
  browser: "Browser",
  lsp: "LSP",
};

const CATEGORY_ORDER: GatewayToolCategory[] = [
  "fs",
  "workspace",
  "runtime",
  "web",
  "sessions",
  "agents",
  "memory",
  "browser",
  "lsp",
];

export function toolsRouter(): Hono {
  const app = new Hono();

  app.get("/v1/tools/catalog", (c) => c.json(buildToolCatalog()));

  return app;
}

export function buildToolCatalog(): ToolCatalogResponse {
  const grouped = new Map<GatewayToolCategory, ToolCatalogItem[]>();
  for (const spec of createCoreToolRegistry().list()) {
    const items = grouped.get(spec.category) ?? [];
    items.push({
      id: spec.id,
      label: spec.label,
      description: spec.description,
      source: spec.source,
      category: spec.category,
      risk: spec.risk,
      idempotent: spec.idempotent,
      sdkName: spec.sdkName,
    });
    grouped.set(spec.category, items);
  }

  return {
    groups: CATEGORY_ORDER.filter((category) => grouped.has(category)).map((category) => ({
      id: category,
      label: CATEGORY_LABELS[category],
      items: grouped.get(category) ?? [],
    })),
  };
}
