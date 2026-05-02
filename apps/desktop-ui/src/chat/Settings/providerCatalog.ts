import type { AuthStatusView } from "../../commandCenterTypes";

/* ============================================================
 * Provider catalog — single source of truth for the list of
 * model providers + their model ids. Both the Settings model
 * section (full configuration UI) and the per-agent model
 * picker (AgentEditModal) read from this list.
 *
 * State (configured / unconfigured) is computed separately
 * since it depends on backend authStatus + localStorage. The
 * catalog itself is static.
 * ============================================================ */

export type ProviderId =
  | "openai"
  | "anthropic"
  | "deepseek"
  | "qwen"
  | "zhipu"
  | "moonshot"
  | "gateway";

export interface ProviderModel {
  id: string;
  hint: string;
}

export interface ProviderSpec {
  id: ProviderId;
  name: string;
  domain: string;
  glyph: string;
  tint: string;
  fg: string;
  placeholder: string;
  models: ReadonlyArray<ProviderModel>;
  /** Internal providers (e.g. Codex Gateway) skip the manual API-key flow. */
  internal?: boolean;
}

export const PROVIDERS: ReadonlyArray<ProviderSpec> = [
  {
    id: "openai",
    name: "OpenAI",
    domain: "api.openai.com",
    glyph: "O",
    tint: "rgba(16, 107, 61, 0.10)",
    fg: "#0a6b3d",
    placeholder: "sk-...",
    models: [
      { id: "gpt-5.4", hint: "通用旗舰" },
      { id: "gpt-5.4-mini", hint: "低成本 · 快" },
      { id: "gpt-4o", hint: "兼容旧 agent" },
      { id: "gpt-4o-mini", hint: "低成本 · 快" },
      { id: "o3-mini", hint: "推理" },
    ],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    domain: "api.anthropic.com",
    glyph: "A",
    tint: "rgba(160, 67, 24, 0.10)",
    fg: "#a04318",
    placeholder: "sk-ant-...",
    models: [
      { id: "claude-sonnet-4.5", hint: "长上下文" },
      { id: "claude-haiku-4-5", hint: "极速短任务" },
      { id: "claude-opus-4", hint: "深度推理" },
    ],
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    domain: "api.deepseek.com",
    glyph: "D",
    tint: "rgba(31, 58, 138, 0.10)",
    fg: "#1f3a8a",
    placeholder: "sk-...",
    models: [
      { id: "deepseek-v3.1", hint: "通用" },
      { id: "deepseek-r1", hint: "推理" },
      { id: "deepseek-coder-v2", hint: "代码" },
    ],
  },
  {
    id: "qwen",
    name: "通义千问",
    domain: "dashscope.aliyuncs.com",
    glyph: "通",
    tint: "rgba(91, 26, 138, 0.10)",
    fg: "#5b1a8a",
    placeholder: "sk-...",
    models: [
      { id: "qwen3-max", hint: "长上下文" },
      { id: "qwen3-plus", hint: "通用" },
      { id: "qwen3-coder-plus", hint: "代码" },
      { id: "qwen3-vl-plus", hint: "多模态" },
    ],
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    domain: "open.bigmodel.cn",
    glyph: "Z",
    tint: "rgba(29, 91, 70, 0.10)",
    fg: "#1d5b46",
    placeholder: "<id>.<secret>",
    models: [
      { id: "glm-4.6", hint: "通用" },
      { id: "glm-4-plus", hint: "长上下文" },
      { id: "glm-4-airx", hint: "低成本 · 快" },
    ],
  },
  {
    id: "moonshot",
    name: "Moonshot Kimi",
    domain: "api.moonshot.cn",
    glyph: "K",
    tint: "rgba(122, 74, 0, 0.10)",
    fg: "#7a4a00",
    placeholder: "sk-...",
    models: [
      { id: "kimi-k2-0905", hint: "通用" },
      { id: "moonshot-v1-128k", hint: "长上下文" },
      { id: "moonshot-v1-32k", hint: "通用" },
    ],
  },
  {
    id: "gateway",
    name: "Codex Gateway",
    domain: "gateway.local",
    glyph: "C",
    tint: "rgba(168, 62, 68, 0.10)",
    fg: "#a83e44",
    placeholder: "内置（无需密钥）",
    models: [
      { id: "gateway/auto", hint: "智能路由" },
      { id: "gateway/long-context", hint: "长上下文" },
      { id: "gateway/cheap", hint: "低成本 · 快" },
    ],
    internal: true,
  },
];

const PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export function findProvider(id: string): ProviderSpec | null {
  return PROVIDER_BY_ID.get(id as ProviderId) ?? null;
}

/**
 * Walk every provider and find which one owns this model id. Used by the
 * picker to colour the chosen model with its provider's mark.
 */
export function findProviderByModel(model: string): ProviderSpec | null {
  if (!model) return null;
  for (const provider of PROVIDERS) {
    if (provider.models.some((m) => m.id === model)) return provider;
  }
  return null;
}

/* ============================================================
 * Configured-state computation. Mirrors the rules in
 * Settings/ModelSection.tsx:
 *   - openai   → backend keychain via authStatus.apiKey
 *   - gateway  → backend Codex login via authStatus.codex
 *   - others   → localStorage flag (UI-only stub for now)
 * ============================================================ */

interface LocalProviderState {
  configured: boolean;
  suffix?: string;
  endpoint?: string;
}

const LS_PROVIDER = (id: ProviderId) => `vulture.provider.${id}`;

function readLocalProvider(id: ProviderId): LocalProviderState {
  try {
    const raw = localStorage.getItem(LS_PROVIDER(id));
    if (!raw) return { configured: false };
    const parsed = JSON.parse(raw) as LocalProviderState;
    return {
      configured: !!parsed.configured,
      suffix: parsed.suffix,
      endpoint: parsed.endpoint,
    };
  } catch {
    return { configured: false };
  }
}

/**
 * Returns the set of provider ids the user has configured. The result is
 * stable enough to feed directly into a `<select>` dropdown — no async,
 * no loading state.
 */
export function configuredProviderIds(
  authStatus: AuthStatusView | null,
): ReadonlySet<ProviderId> {
  const set = new Set<ProviderId>();
  if (authStatus?.apiKey?.state === "set") set.add("openai");
  if (authStatus?.codex?.state === "signed_in") set.add("gateway");
  for (const provider of PROVIDERS) {
    if (provider.id === "openai" || provider.id === "gateway") continue;
    if (readLocalProvider(provider.id).configured) set.add(provider.id);
  }
  return set;
}

/**
 * The flat list of "{provider, model}" pairs the user can pick from.
 * If the requested model isn't in any configured provider it is still
 * appended (with the provider it belongs to) so an existing agent's
 * model never silently disappears from the picker — the user just sees
 * a "未配置" hint next to it.
 */
export interface ValidatedModelOption {
  provider: ProviderSpec;
  model: ProviderModel;
  configured: boolean;
}

export function validatedModelOptions(
  authStatus: AuthStatusView | null,
  preserveModel?: string,
): ValidatedModelOption[] {
  const configured = configuredProviderIds(authStatus);
  const options: ValidatedModelOption[] = [];
  for (const provider of PROVIDERS) {
    const isConfigured = configured.has(provider.id);
    for (const model of provider.models) {
      if (isConfigured) {
        options.push({ provider, model, configured: true });
      }
    }
  }
  if (preserveModel) {
    const already = options.some((o) => o.model.id === preserveModel);
    if (!already) {
      const owner = findProviderByModel(preserveModel);
      if (owner) {
        options.push({
          provider: owner,
          model: { id: preserveModel, hint: "未配置" },
          configured: false,
        });
      } else {
        // Unknown model — keep it as a free-form entry under a synthetic
        // "其他" group so the user can still see what's saved.
        options.push({
          provider: {
            id: "openai",
            name: "未知提供方",
            domain: "—",
            glyph: "?",
            tint: "rgba(120,120,120,0.10)",
            fg: "#666",
            placeholder: "",
            models: [],
          },
          model: { id: preserveModel, hint: "未识别" },
          configured: false,
        });
      }
    }
  }
  return options;
}
