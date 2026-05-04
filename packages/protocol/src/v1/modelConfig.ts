import { z } from "zod";

const NonEmptyIdSchema = z.string().trim().min(1);

export const ModelApiSchema = z.enum([
  "openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "gemini-generate-content",
]);
export type ModelApi = z.infer<typeof ModelApiSchema>;

export const ModelProviderAuthModeSchema = z.enum(["api-key", "oauth", "token", "none"]);
export type ModelProviderAuthMode = z.infer<typeof ModelProviderAuthModeSchema>;

export const ModelInputTypeSchema = z.enum(["text", "image", "audio", "video", "document"]);
export type ModelInputType = z.infer<typeof ModelInputTypeSchema>;

export const ModelCatalogEntrySchema = z
  .object({
    id: NonEmptyIdSchema,
    modelRef: NonEmptyIdSchema,
    name: z.string().trim().min(1),
    reasoning: z.boolean(),
    input: z.array(ModelInputTypeSchema),
    contextWindow: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    compat: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;

export const AuthProfileModeSchema = z.enum(["api_key", "oauth", "token", "none"]);
export type AuthProfileMode = z.infer<typeof AuthProfileModeSchema>;

export const AuthProfileStatusSchema = z.enum([
  "configured",
  "missing",
  "expired",
  "error",
  "unsupported",
]);
export type AuthProfileStatus = z.infer<typeof AuthProfileStatusSchema>;

export const AuthProfileViewSchema = z
  .object({
    id: NonEmptyIdSchema,
    provider: NonEmptyIdSchema,
    mode: AuthProfileModeSchema,
    label: z.string().trim().min(1),
    status: AuthProfileStatusSchema,
    email: z.string().trim().min(1).optional(),
    expiresAt: z.number().int().optional(),
    message: z.string().trim().min(1).optional(),
  })
  .strict();
export type AuthProfileView = z.infer<typeof AuthProfileViewSchema>;

export const ModelProviderViewSchema = z
  .object({
    id: NonEmptyIdSchema,
    name: z.string().trim().min(1),
    baseUrl: z.string().trim().min(1).nullable().optional(),
    api: ModelApiSchema.optional(),
    auth: ModelProviderAuthModeSchema.optional(),
    models: z.array(ModelCatalogEntrySchema),
    authProfiles: z.array(AuthProfileViewSchema),
    authOrder: z.array(NonEmptyIdSchema),
  })
  .strict();
export type ModelProviderView = z.infer<typeof ModelProviderViewSchema>;

export const ModelSettingsResponseSchema = z
  .object({
    providers: z.array(ModelProviderViewSchema),
  })
  .strict();
export type ModelSettingsResponse = z.infer<typeof ModelSettingsResponseSchema>;

export const UpdateModelAuthOrderSchema = z
  .object({
    provider: NonEmptyIdSchema,
    authOrder: z.array(NonEmptyIdSchema),
  })
  .strict();
export type UpdateModelAuthOrder = z.infer<typeof UpdateModelAuthOrderSchema>;

export interface ParsedModelRef {
  raw: string;
  modelRef: string;
  provider: string;
  model: string;
  profileId?: string;
  explicitProfile: boolean;
}

const DATE_MODEL_SUFFIX_RE = /^\d{8}$/;
const LOCAL_QUANT_MODEL_SUFFIX_RE = /^q\d+(?:_\d+)?$/i;

export function parseModelRefWithProfile(
  raw: string,
  defaultProvider = "openai",
): ParsedModelRef | null {
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
  let profileId: string | null = null;
  let explicitProfile = false;

  if (atParts.length >= 3) {
    profileId = atParts.at(-1) ?? null;
    model = atParts.slice(0, -1).join("@");
    explicitProfile = true;
  } else if (atParts.length === 2 && !isKnownModelSuffix(atParts[1] ?? "")) {
    [model, profileId] = atParts as [string, string];
    explicitProfile = true;
  }

  if (!model || (explicitProfile && !profileId)) return null;

  const modelRef = `${provider}/${model}`;
  if (
    !NonEmptyIdSchema.safeParse(provider).success ||
    !NonEmptyIdSchema.safeParse(model).success ||
    !NonEmptyIdSchema.safeParse(modelRef).success ||
    (profileId !== null && !NonEmptyIdSchema.safeParse(profileId).success)
  ) {
    return null;
  }

  const parsed: ParsedModelRef = {
    raw: value,
    modelRef,
    provider,
    model,
    explicitProfile,
  };
  if (profileId !== null) parsed.profileId = profileId;
  return parsed;
}

function isKnownModelSuffix(suffix: string): boolean {
  return DATE_MODEL_SUFFIX_RE.test(suffix) || LOCAL_QUANT_MODEL_SUFFIX_RE.test(suffix);
}
