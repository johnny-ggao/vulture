const SUPPORTED_MODELS = new Set(["gpt-5.4", "gpt-5.5", "gpt-4o", "gpt-4o-mini"]);
export const DEFAULT_MODEL = "gpt-5.4";

export function selectModel(requested: string): string {
  if (SUPPORTED_MODELS.has(requested)) return requested;
  return DEFAULT_MODEL;
}

export function isApiKeyConfigured(env: Record<string, string | undefined>): boolean {
  const k = env.OPENAI_API_KEY;
  return typeof k === "string" && k.length > 0;
}
