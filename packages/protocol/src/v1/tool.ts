import { z } from "zod";
import type { BrandedId } from "@vulture/common";

export type ToolName = BrandedId<"ToolName">;

export const ToolSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: z.unknown(),
  requiresApproval: z.boolean(),
});
export type Tool = Omit<z.infer<typeof ToolSchema>, "name"> & { name: ToolName };

export const ApprovalDecisionSchema = z.enum(["allow", "deny"]);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalSchema = z.object({
  token: z.string().min(1),
  decision: ApprovalDecisionSchema,
  at: z.string().min(1),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const ToolInvocationContextSchema = z.object({
  workspace: z.object({
    id: z.string().min(1),
    path: z.string().min(1),
  }),
  approval: ApprovalSchema.nullable(),
});
export type ToolInvocationContext = z.infer<typeof ToolInvocationContextSchema>;
