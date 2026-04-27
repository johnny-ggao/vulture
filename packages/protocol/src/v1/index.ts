import { z } from "zod";
import type { BrandedId } from "@vulture/common";

export const API_VERSION = "v1" as const;
export type ApiVersion = typeof API_VERSION;

export type Iso8601 = BrandedId<"Iso8601">;

const ISO8601_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const Iso8601Schema = z.string().regex(ISO8601_RE);

export function brandIso8601(value: string): Iso8601 {
  if (!ISO8601_RE.test(value)) {
    throw new Error(`invalid Iso8601 timestamp: ${value}`);
  }
  return value as Iso8601;
}

export function nowIso8601(): Iso8601 {
  return brandIso8601(new Date().toISOString());
}
