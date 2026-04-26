import { z } from "zod";
import type { BrandedId } from "@vulture/common";
import type { Iso8601 } from "./index";

export type WorkspaceId = BrandedId<"WorkspaceId">;

const Iso8601Schema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);

const SlugSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);

export const WorkspaceSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1),
  path: z.string().min(1),
  createdAt: Iso8601Schema,
  updatedAt: Iso8601Schema,
});

export type Workspace = Omit<
  z.infer<typeof WorkspaceSchema>,
  "id" | "createdAt" | "updatedAt"
> & {
  id: WorkspaceId;
  createdAt: Iso8601;
  updatedAt: Iso8601;
};

export const SaveWorkspaceRequestSchema = z
  .object({
    id: SlugSchema,
    name: z.string().min(1),
    path: z.string().min(1),
  })
  .strict();

export type SaveWorkspaceRequest = z.infer<typeof SaveWorkspaceRequestSchema>;
