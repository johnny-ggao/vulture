const BARE_OPENAI_MODEL_IDS = new Set([
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-4o",
  "gpt-4o-mini",
  "o3-mini",
]);

const LEGACY_GATEWAY_MODEL_REFS: Record<string, string> = {
  "gateway/auto": "openai/gpt-5.5@codex",
  "gateway/long-context": "openai/gpt-5.5@codex",
  "gateway/cheap": "openai/gpt-5.4-mini@codex",
};

export function normalizePersistedAgentModel(model: string): string {
  const legacyGatewayModel = LEGACY_GATEWAY_MODEL_REFS[model];
  if (legacyGatewayModel) return legacyGatewayModel;

  if (BARE_OPENAI_MODEL_IDS.has(model)) {
    return `openai/${model}`;
  }

  return model;
}
