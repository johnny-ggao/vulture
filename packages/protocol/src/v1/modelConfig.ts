import { z } from "zod";

const NonEmptyIdSchema = z.string().trim().min(1);

export const ModelApiSchema = z.enum([
  "responses",
  "chat_completions",
  "anthropic_messages",
  "openai_compatible",
  "ollama",
  "local",
]);
export type ModelApi = z.infer<typeof ModelApiSchema>;

export const ModelProviderAuthModeSchema = z.enum(["api_key", "oauth", "local", "none"]);
export type ModelProviderAuthMode = z.infer<typeof ModelProviderAuthModeSchema>;

export const ModelInputTypeSchema = z.enum(["text", "image", "audio", "file"]);
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
    compat: z.union([z.array(NonEmptyIdSchema), z.record(z.string(), z.unknown())]).optional(),
  })
  .strict();
export type ModelCatalogEntry = z.infer<typeof ModelCatalogEntrySchema>;

export const AuthProfileModeSchema = z.enum(["api_key", "oauth", "local", "none"]);
export type AuthProfileMode = z.infer<typeof AuthProfileModeSchema>;

export const AuthProfileStatusSchema = z.enum([
  "configured",
  "missing",
  "expired",
  "refreshing",
  "error",
]);
export type AuthProfileStatus = z.infer<typeof AuthProfileStatusSchema>;

export const AuthProfileViewSchema = z
  .object({
    id: NonEmptyIdSchema,
    label: z.string().trim().min(1),
    mode: AuthProfileModeSchema,
    status: AuthProfileStatusSchema,
    isDefault: z.boolean().default(false),
    accountLabel: z.string().trim().min(1).nullable().optional(),
    expiresAt: z.string().trim().min(1).nullable().optional(),
    error: z.string().trim().min(1).nullable().optional(),
  })
  .strict();
export type AuthProfileView = z.infer<typeof AuthProfileViewSchema>;

export const ModelProviderViewSchema = z
  .object({
    id: NonEmptyIdSchema,
    name: z.string().trim().min(1),
    api: ModelApiSchema,
    authModes: z.array(ModelProviderAuthModeSchema),
    baseUrl: z.string().trim().min(1).nullable().optional(),
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
    authOrder: z.array(NonEmptyIdSchema),
  })
  .strict();
export type UpdateModelAuthOrder = z.infer<typeof UpdateModelAuthOrderSchema>;

export interface ParsedModelRef {
  raw: string;
  modelRef: string;
  provider: string;
  model: string;
  profileId: string | null;
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

  return {
    raw: value,
    modelRef,
    provider,
    model,
    profileId,
    explicitProfile,
  };
}

function isKnownModelSuffix(suffix: string): boolean {
  return DATE_MODEL_SUFFIX_RE.test(suffix) || LOCAL_QUANT_MODEL_SUFFIX_RE.test(suffix);
}
