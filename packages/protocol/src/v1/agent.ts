import { z } from "zod";
import type { BrandedId } from "@vulture/common";
import type { Iso8601 } from "./index";
import { WorkspaceSchema, SaveWorkspaceRequestSchema } from "./workspace";

export type AgentId = BrandedId<"AgentId">;

export const AGENT_TOOL_NAMES = [
  "shell.exec",
  "browser.snapshot",
  "browser.click",
] as const;
export const AgentToolNameSchema = z.enum(AGENT_TOOL_NAMES);
export type AgentToolName = z.infer<typeof AgentToolNameSchema>;

export const ReasoningLevelSchema = z.enum(["low", "medium", "high"]);
export type ReasoningLevel = z.infer<typeof ReasoningLevelSchema>;

const Iso8601Schema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);

const SlugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);

export const AgentSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1),
  description: z.string(),
  model: z.string().min(1),
  reasoning: ReasoningLevelSchema,
  tools: z.array(AgentToolNameSchema),
  workspace: WorkspaceSchema,
  instructions: z.string().min(1),
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
    workspace: SaveWorkspaceRequestSchema.optional(),
    instructions: z.string().min(1),
  })
  .strict();

export type SaveAgentRequest = z.infer<typeof SaveAgentRequestSchema>;
