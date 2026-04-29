import type { ApiClient } from "./client";
import type { AgentToolName, AgentToolPreset } from "./agents";

export type ToolRisk = "safe" | "approval" | "dangerous";
export type ToolSource = "core" | "plugin" | "mcp";
export type ToolCategory =
  | "runtime"
  | "browser"
  | "fs"
  | "workspace"
  | "web"
  | "sessions"
  | "memory"
  | "agents";

export interface ToolCatalogItem {
  id: AgentToolName;
  label: string;
  description: string;
  source: ToolSource;
  category: ToolCategory;
  risk: ToolRisk;
  idempotent: boolean;
  sdkName: string;
}

export interface ToolCatalogGroup {
  id: ToolCategory;
  label: string;
  items: ToolCatalogItem[];
}

export const TOOL_PRESETS: Record<AgentToolPreset, readonly AgentToolName[]> = {
  none: [],
  minimal: ["read", "web_search", "web_fetch"],
  standard: [
    "read",
    "write",
    "edit",
    "web_search",
    "web_fetch",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "sessions_yield",
    "update_plan",
    "memory_search",
    "memory_get",
    "memory_append",
  ],
  developer: [
    "read",
    "write",
    "edit",
    "apply_patch",
    "shell.exec",
    "process",
    "web_search",
    "web_fetch",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "sessions_yield",
    "update_plan",
    "memory_search",
    "memory_get",
    "memory_append",
    "browser.snapshot",
    "browser.click",
  ],
  tl: [
    "read",
    "write",
    "edit",
    "web_search",
    "web_fetch",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "sessions_yield",
    "update_plan",
    "memory_search",
    "memory_get",
    "memory_append",
  ],
  full: [
    "read",
    "write",
    "edit",
    "apply_patch",
    "shell.exec",
    "process",
    "web_search",
    "web_fetch",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "sessions_yield",
    "update_plan",
    "memory_search",
    "memory_get",
    "memory_append",
    "browser.snapshot",
    "browser.click",
  ],
};

export interface ToolPolicyDraft {
  tools: AgentToolName[];
  toolPreset: AgentToolPreset;
  toolInclude: AgentToolName[];
  toolExclude: AgentToolName[];
}

export interface ToolCapability {
  id: string;
  label: string;
  description: string;
  toolIds: AgentToolName[];
}

export const TOOL_CAPABILITIES: ToolCapability[] = [
  {
    id: "files",
    label: "Files",
    description: "Read workspace files and make controlled file edits.",
    toolIds: ["read", "write", "edit", "apply_patch"],
  },
  {
    id: "web",
    label: "Web",
    description: "Search the web and fetch pages when current information is needed.",
    toolIds: ["web_search", "web_fetch"],
  },
  {
    id: "coding",
    label: "Coding",
    description: "Run local commands and inspect long-running processes.",
    toolIds: ["shell.exec", "process"],
  },
  {
    id: "memory",
    label: "Memory",
    description: "Search, read, and append durable agent memory.",
    toolIds: ["memory_search", "memory_get", "memory_append"],
  },
  {
    id: "collaboration",
    label: "Sessions",
    description: "Work with other sessions and keep an explicit task plan.",
    toolIds: ["sessions_list", "sessions_history", "sessions_send", "sessions_spawn", "sessions_yield", "update_plan"],
  },
  {
    id: "browser",
    label: "Browser",
    description: "Inspect and interact with browser pages through snapshots and clicks.",
    toolIds: ["browser.snapshot", "browser.click"],
  },
];

export function toolPolicyFromSelection(
  toolPreset: AgentToolPreset,
  tools: ReadonlyArray<AgentToolName>,
): ToolPolicyDraft {
  const selected = uniqueTools(tools);
  const presetTools = TOOL_PRESETS[toolPreset];
  const presetSet = new Set(presetTools);
  const selectedSet = new Set(selected);
  return {
    tools: selected,
    toolPreset,
    toolInclude: selected.filter((tool) => !presetSet.has(tool)),
    toolExclude: presetTools.filter((tool) => !selectedSet.has(tool)),
  };
}

export function toolPolicyFromPreset(toolPreset: AgentToolPreset): ToolPolicyDraft {
  return {
    tools: [...TOOL_PRESETS[toolPreset]],
    toolPreset,
    toolInclude: [],
    toolExclude: [],
  };
}

function uniqueTools(tools: ReadonlyArray<AgentToolName>): AgentToolName[] {
  return [...new Set(tools)];
}

function coreTool(
  id: AgentToolName,
  label: string,
  category: ToolCategory,
  risk: ToolRisk,
  idempotent: boolean,
  sdkName = id.replaceAll(".", "_"),
): ToolCatalogItem {
  return {
    id,
    label,
    description: "",
    source: "core",
    category,
    risk,
    idempotent,
    sdkName,
  };
}

export const FALLBACK_TOOL_CATALOG: ToolCatalogGroup[] = [
  {
    id: "fs",
    label: "Files",
    items: [
      coreTool("read", "Read", "fs", "safe", true),
      coreTool("write", "Write", "fs", "approval", false),
      coreTool("edit", "Edit", "fs", "approval", false),
      coreTool("apply_patch", "Apply Patch", "fs", "approval", false),
    ],
  },
  {
    id: "runtime",
    label: "Runtime",
    items: [
      coreTool("shell.exec", "Shell Exec", "runtime", "approval", false, "shell_exec"),
      coreTool("process", "Process", "runtime", "approval", false),
    ],
  },
  {
    id: "web",
    label: "Web",
    items: [
      coreTool("web_search", "Web Search", "web", "safe", true),
      coreTool("web_fetch", "Web Fetch", "web", "safe", true),
    ],
  },
  {
    id: "sessions",
    label: "Sessions",
    items: [
      coreTool("sessions_list", "Sessions List", "sessions", "safe", true),
      coreTool("sessions_history", "Sessions History", "sessions", "safe", true),
      coreTool("sessions_send", "Sessions Send", "sessions", "approval", false),
      coreTool("sessions_spawn", "Sessions Spawn", "sessions", "approval", false),
      coreTool("sessions_yield", "Sessions Yield", "sessions", "safe", true),
    ],
  },
  {
    id: "agents",
    label: "Agents",
    items: [coreTool("update_plan", "Update Plan", "agents", "safe", true)],
  },
  {
    id: "memory",
    label: "Memory",
    items: [
      coreTool("memory_search", "Memory Search", "memory", "safe", true),
      coreTool("memory_get", "Memory Get", "memory", "safe", true),
      coreTool("memory_append", "Memory Append", "memory", "approval", false),
    ],
  },
  {
    id: "browser",
    label: "Browser",
    items: [
      coreTool("browser.snapshot", "Browser Snapshot", "browser", "approval", true, "browser_snapshot"),
      coreTool("browser.click", "Browser Click", "browser", "approval", false, "browser_click"),
    ],
  },
];

export const toolsApi = {
  catalog: async (client: ApiClient) =>
    (await client.get<{ groups: ToolCatalogGroup[] }>("/v1/tools/catalog")).groups,
};
