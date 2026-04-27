import { z } from "zod";
import { API_VERSION, Iso8601Schema, type Iso8601 } from "./index";

const PortSchema = z.number().int().min(1).max(65535);

export const RuntimeDescriptorSchema = z.object({
  apiVersion: z.literal(API_VERSION),
  gateway: z.object({ port: PortSchema }),
  shell: z.object({ port: PortSchema }),
  // url-safe base64 of 32 random bytes is 43 chars (no padding)
  token: z.string().length(43),
  pid: z.number().int().min(1),
  startedAt: Iso8601Schema,
  shellVersion: z.string().min(1),
});

export type RuntimeDescriptor = Omit<
  z.infer<typeof RuntimeDescriptorSchema>,
  "startedAt"
> & {
  startedAt: Iso8601;
};
