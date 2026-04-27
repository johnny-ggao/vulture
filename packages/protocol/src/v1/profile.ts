import { z } from "zod";
import type { BrandedId } from "@vulture/common";
import { Iso8601Schema, type Iso8601 } from "./index";

export type ProfileId = BrandedId<"ProfileId">;
export type AgentId = BrandedId<"AgentId">;

export const ProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  activeAgentId: z.string().min(1).nullable(),
  createdAt: Iso8601Schema,
  updatedAt: Iso8601Schema,
});

export type Profile = Omit<
  z.infer<typeof ProfileSchema>,
  "id" | "activeAgentId" | "createdAt" | "updatedAt"
> & {
  id: ProfileId;
  activeAgentId: AgentId | null;
  createdAt: Iso8601;
  updatedAt: Iso8601;
};

export const UpdateProfileRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    activeAgentId: z.string().min(1).nullable().optional(),
  })
  .strict();

export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequestSchema>;
