import { z } from "zod";

export const ErrorCodeSchema = z.enum([
  "auth.token_invalid",
  "auth.origin_invalid",
  "auth.missing_keychain",
  "agent.not_found",
  "agent.invalid",
  "agent.cannot_delete_last",
  "workspace.invalid_path",
  "conversation.not_found",
  "run.not_found",
  "run.cancelled",
  "run.already_completed",
  "tool.permission_denied",
  "tool.execution_failed",
  "llm.provider_error",
  "llm.rate_limited",
  "internal",
  "internal.gateway_restarted",
  "internal.shutdown",
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const AppErrorSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type AppError = z.infer<typeof AppErrorSchema>;
