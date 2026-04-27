import { z } from "zod";
import { ApprovalDecisionSchema } from "./tool";

export const ApprovalRequestSchema = z
  .object({
    callId: z.string().min(1),
    decision: ApprovalDecisionSchema,
  })
  .strict();
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
