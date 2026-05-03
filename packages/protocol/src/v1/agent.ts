import { z } from "zod";
import type { BrandedId } from "@vulture/common";
import { Iso8601Schema, type Iso8601 } from "./index";
import { WorkspaceSchema, SaveWorkspaceRequestSchema } from "./workspace";

export type AgentId = BrandedId<"AgentId">;

export const AGENT_TOOL_NAMES = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "shell.exec",
  "process",
  "web_search",
  "web_fetch",
  "web_extract",
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
  "browser.input",
  "browser.scroll",
  "browser.extract",
  "browser.navigate",
  "browser.wait",
  "browser.screenshot",
  "grep",
  "glob",
  "lsp.diagnostics",
  "lsp.definition",
  "lsp.references",
  "lsp.hover",
] as const;
export const AgentToolNameSchema = z.enum(AGENT_TOOL_NAMES);
export type AgentToolName = z.infer<typeof AgentToolNameSchema>;

export const AgentToolPresetSchema = z.enum([
  "none",
  "minimal",
  "standard",
  "developer",
  "tl",
  "full",
]);
export type AgentToolPreset = z.infer<typeof AgentToolPresetSchema>;

export const AGENT_TOOL_PRESETS: Record<AgentToolPreset, readonly AgentToolName[]> = {
  none: [],
  minimal: ["read", "web_search", "web_fetch", "web_extract", "grep", "glob"],
  standard: [
    "read",
    "write",
    "edit",
    "web_search",
    "web_fetch",
    "web_extract",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "sessions_yield",
    "update_plan",
    "memory_search",
    "memory_get",
    "memory_append",
    "grep",
    "glob",
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
    "web_extract",
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
    "browser.input",
    "browser.scroll",
    "browser.extract",
    "browser.navigate",
    "browser.wait",
    "browser.screenshot",
    "grep",
    "glob",
    "lsp.diagnostics",
    "lsp.definition",
    "lsp.references",
    "lsp.hover",
  ],
  tl: [
    "read",
    "write",
    "edit",
    "web_search",
    "web_fetch",
    "web_extract",
    "sessions_list",
    "sessions_history",
    "sessions_send",
    "sessions_spawn",
    "sessions_yield",
    "update_plan",
    "memory_search",
    "memory_get",
    "memory_append",
    "grep",
    "glob",
  ],
  full: AGENT_TOOL_NAMES,
};

export const ReasoningLevelSchema = z.enum(["low", "medium", "high"]);
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

const SlugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
const SkillNameSchema = z.string().min(1);

export const AgentSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1),
  description: z.string(),
  model: z.string().min(1),
  reasoning: ReasoningLevelSchema,
  tools: z.array(AgentToolNameSchema),
  toolPreset: AgentToolPresetSchema,
  toolInclude: z.array(AgentToolNameSchema),
  toolExclude: z.array(AgentToolNameSchema),
  skills: z.array(SkillNameSchema).optional(),
  handoffAgentIds: z.array(SlugSchema),
  workspace: WorkspaceSchema,
  instructions: z.string().min(1),
  /**
   * Optional avatar identifier owned by the client (e.g. preset key).
   * The gateway treats this opaquely; presets and rendering live in
   * the desktop app.
   */
  avatar: z.string().optional(),
  createdAt: Iso8601Schema,
  updatedAt: Iso8601Schema,
});

export type Agent = Omit<
  z.infer<typeof AgentSchema>,
  "id" | "createdAt" | "updatedAt"
> & {
  id: AgentId;
  createdAt: Iso8601;
  updatedAt: Iso8601;
};

export const SaveAgentRequestSchema = z
  .object({
    id: SlugSchema,
    name: z.string().min(1),
    description: z.string().default(""),
    model: z.string().min(1),
    reasoning: ReasoningLevelSchema,
    tools: z.array(AgentToolNameSchema).default([]),
    toolPreset: AgentToolPresetSchema.optional(),
    toolInclude: z.array(AgentToolNameSchema).optional(),
    toolExclude: z.array(AgentToolNameSchema).optional(),
    skills: z.array(SkillNameSchema).optional(),
    handoffAgentIds: z.array(SlugSchema).optional(),
    workspace: SaveWorkspaceRequestSchema.optional(),
    instructions: z.string().min(1),
    avatar: z.string().optional(),
  })
  .strict();

export type SaveAgentRequest = z.infer<typeof SaveAgentRequestSchema>;
