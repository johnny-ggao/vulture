import { z } from "zod";

const ModelConfigIdSchema = z.string().trim().min(1);

export const ModelAuthKindSchema = z.enum(["api_key", "oauth", "local", "none"]);
export type ModelAuthKind = z.infer<typeof ModelAuthKindSchema>;

export const ModelProviderModelSchema = z
  .object({
    id: ModelConfigIdSchema,
    name: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    supportsApiKey: z.boolean().default(false),
    supportsOAuth: z.boolean().default(false),
    supportsLocal: z.boolean().default(false),
  })
  .strict();
export type ModelProviderModel = z.infer<typeof ModelProviderModelSchema>;

export const ModelAuthProfileViewSchema = z
  .object({
    id: ModelConfigIdSchema,
    label: z.string().trim().min(1),
    kind: ModelAuthKindSchema,
    configured: z.boolean(),
    isDefault: z.boolean().default(false),
    accountLabel: z.string().trim().min(1).nullable().optional(),
    expiresAt: z.string().trim().min(1).nullable().optional(),
  })
  .strict();
export type ModelAuthProfileView = z.infer<typeof ModelAuthProfileViewSchema>;

export const ModelProviderCatalogEntrySchema = z
  .object({
    id: ModelConfigIdSchema,
    name: z.string().trim().min(1),
    baseUrl: z.string().trim().min(1).nullable().optional(),
    models: z.array(ModelProviderModelSchema),
    authProfiles: z.array(ModelAuthProfileViewSchema).default([]),
  })
  .strict();
export type ModelProviderCatalogEntry = z.infer<typeof ModelProviderCatalogEntrySchema>;

export const ModelProviderCatalogSchema = z.array(ModelProviderCatalogEntrySchema);
export type ModelProviderCatalog = z.infer<typeof ModelProviderCatalogSchema>;

export const ParsedModelRefWithProfileSchema = z
  .object({
    provider: ModelConfigIdSchema,
    model: ModelConfigIdSchema,
    authProfileId: ModelConfigIdSchema.nullable(),
  })
  .strict();
export type ParsedModelRefWithProfile = z.infer<typeof ParsedModelRefWithProfileSchema>;

export const ModelSettingsResponseSchema = z
  .object({
    providers: ModelProviderCatalogSchema,
    selectedModel: ParsedModelRefWithProfileSchema,
    authOrder: z.array(ModelConfigIdSchema),
  })
  .strict();
export type ModelSettingsResponse = z.infer<typeof ModelSettingsResponseSchema>;

export const ModelAuthOrderUpdateSchema = z
  .object({
    authOrder: z.array(ModelConfigIdSchema),
  })
  .strict();
export type ModelAuthOrderUpdate = z.infer<typeof ModelAuthOrderUpdateSchema>;

const DATE_MODEL_SUFFIX_RE = /^\d{8}$/;
const LOCAL_QUANT_MODEL_SUFFIX_RE = /^q\d+(?:_\d+)?$/i;

export function parseModelRefWithProfile(
  raw: string,
  defaultProvider = "openai",
): ParsedModelRefWithProfile | null {
  const value = raw.trim();
  const fallbackProvider = defaultProvider.trim();
  if (!value || !fallbackProvider) return null;

  const slashIndex = value.indexOf("/");
  const provider = slashIndex === -1 ? fallbackProvider : value.slice(0, slashIndex).trim();
  const modelAndProfile = slashIndex === -1 ? value : value.slice(slashIndex + 1).trim();
  if (!provider || !modelAndProfile || modelAndProfile.includes("/")) return null;

  const atParts = modelAndProfile.split("@");
  if (atParts.some((part) => part.length === 0)) return null;

  let model = modelAndProfile;
  let authProfileId: string | null = null;

  if (atParts.length >= 3) {
    authProfileId = atParts.at(-1) ?? null;
    model = atParts.slice(0, -1).join("@");
  } else if (atParts.length === 2 && !isKnownModelSuffix(atParts[1] ?? "")) {
    [model, authProfileId] = atParts as [string, string];
  }

  const parsed = ParsedModelRefWithProfileSchema.safeParse({
    provider,
    model,
    authProfileId,
  });
  return parsed.success ? parsed.data : null;
}

function isKnownModelSuffix(suffix: string): boolean {
  return DATE_MODEL_SUFFIX_RE.test(suffix) || LOCAL_QUANT_MODEL_SUFFIX_RE.test(suffix);
}
