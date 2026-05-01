import { useEffect, useMemo, useState } from "react";
import { SettingsSection } from "./SettingsSection";
import type { SettingsPageProps } from "./types";

/* ============================================================
 * Multi-provider model directory.
 *
 * Layout (mirrors the kit):
 *   ┌─ provider list (left rail)
 *   └─ provider detail (right pane)
 *       · header (glyph mark + name + domain + status pill)
 *       · API Key field (masked display + 更换 / 移除, or edit mode)
 *       · Custom Endpoint
 *       · Supported models list
 *
 * Bound to real backend for two providers:
 *   - OpenAI       → props.authStatus.apiKey + onSaveApiKey / onClearApiKey
 *   - Codex Gateway → props.authStatus.codex + onSignInWithChatGPT / onSignOutCodex
 * Other providers persist their key locally as a "configured" flag with
 * masked-suffix preview only (no plaintext); a banner notes this is UI-only
 * until backend wiring lands.
 * ============================================================ */

interface ProviderSpec {
  id: ProviderId;
  name: string;
  domain: string;
  glyph: string;
  tint: string;
  fg: string;
  placeholder: string;
  models: ReadonlyArray<{ id: string; hint: string }>;
  /** When true the provider has no manual key (e.g. internal gateway). */
  internal?: boolean;
}

type ProviderId =
  | "openai"
  | "anthropic"
  | "deepseek"
  | "qwen"
  | "zhipu"
  | "moonshot"
  | "gateway";

const PROVIDERS: ReadonlyArray<ProviderSpec> = [
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

/* Provider state is stored locally for non-OpenAI providers. We store
 * a redacted key (only the last 4 chars, like Stripe), never the
 * plaintext, so a localStorage scrape doesn't leak the secret. */
interface LocalProviderState {
  configured: boolean;
  /** Last 4 chars of the key, used to render `sk-•••3F2a`-style preview. */
  suffix?: string;
  endpoint?: string;
}
const LS_PROVIDER = (id: ProviderId) => `vulture.provider.${id}`;
const LS_DEFAULTS = "vulture.provider.defaults";

function readLocalProvider(id: ProviderId): LocalProviderState {
  try {
    const raw = localStorage.getItem(LS_PROVIDER(id));
    if (!raw) return { configured: false };
    const parsed = JSON.parse(raw) as LocalProviderState;
    return { configured: !!parsed.configured, suffix: parsed.suffix, endpoint: parsed.endpoint };
  } catch {
    return { configured: false };
  }
}
function writeLocalProvider(id: ProviderId, value: LocalProviderState) {
  try {
    localStorage.setItem(LS_PROVIDER(id), JSON.stringify(value));
  } catch {
    /* localStorage unavailable — silently no-op. */
  }
}

interface DefaultsState {
  provider: ProviderId;
  model: string;
}
function readDefaults(): DefaultsState {
  try {
    const raw = localStorage.getItem(LS_DEFAULTS);
    if (!raw) return { provider: "openai", model: PROVIDERS[0]!.models[0]!.id };
    return JSON.parse(raw) as DefaultsState;
  } catch {
    return { provider: "openai", model: PROVIDERS[0]!.models[0]!.id };
  }
}
function writeDefaults(value: DefaultsState) {
  try {
    localStorage.setItem(LS_DEFAULTS, JSON.stringify(value));
  } catch {
    /* no-op */
  }
}

export function ModelSection(props: SettingsPageProps) {
  const [activeId, setActiveId] = useState<ProviderId>("openai");
  const [editing, setEditing] = useState(false);
  const [draftKey, setDraftKey] = useState("");
  const [busy, setBusy] = useState<"save" | "clear" | "signin" | "signout" | null>(null);
  const [defaults, setDefaults] = useState<DefaultsState>(() => readDefaults());

  // Local-state map of all providers' configured/suffix flags. Re-read
  // from storage when the active provider changes since another tab
  // could have edited it.
  const [localState, setLocalState] = useState<Record<ProviderId, LocalProviderState>>(() => {
    const next: Record<string, LocalProviderState> = {};
    for (const p of PROVIDERS) next[p.id] = readLocalProvider(p.id);
    return next as Record<ProviderId, LocalProviderState>;
  });

  useEffect(() => {
    setEditing(false);
    setDraftKey("");
  }, [activeId]);

  const active = PROVIDERS.find((p) => p.id === activeId)!;
  const codex = props.authStatus?.codex;
  const apiKey = props.authStatus?.apiKey;

  // Compute "configured" / "status" / "suffix" for the active provider.
  // OpenAI + Codex are bound to backend state; others use localState.
  const status: ProviderStatus = useMemo(() => {
    if (active.id === "openai") {
      if (apiKey?.state === "set") return { kind: "configured", suffix: "已配置", source: apiKey.source ?? "keychain" };
      return { kind: "empty" };
    }
    if (active.id === "gateway") {
      if (codex?.state === "signed_in") return { kind: "configured", suffix: codex.email ?? "已登录" };
      if (codex?.state === "expired") return { kind: "expired", suffix: codex.email ?? "凭据过期" };
      return { kind: "empty" };
    }
    const ls = localState[active.id];
    if (ls.configured) return { kind: "configured", suffix: ls.suffix ? `sk-•••${ls.suffix}` : "已配置" };
    return { kind: "empty" };
  }, [active.id, apiKey, codex, localState]);

  async function safeAction<T>(label: NonNullable<typeof busy>, fn: () => Promise<T>) {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  async function handleSave() {
    const key = draftKey.trim();
    if (!key) return;
    if (active.id === "openai") {
      await safeAction("save", () => props.onSaveApiKey(key));
    } else {
      // localStorage: store a 4-char suffix so masked preview stays useful.
      const suffix = key.length >= 4 ? key.slice(-4) : key;
      const next: LocalProviderState = { configured: true, suffix };
      writeLocalProvider(active.id, next);
      setLocalState((prev) => ({ ...prev, [active.id]: next }));
    }
    setEditing(false);
    setDraftKey("");
  }

  async function handleClear() {
    if (active.id === "openai") {
      await safeAction("clear", () => props.onClearApiKey());
    } else {
      const next: LocalProviderState = { configured: false };
      writeLocalProvider(active.id, next);
      setLocalState((prev) => ({ ...prev, [active.id]: next }));
    }
  }

  async function handleSignIn() {
    await safeAction("signin", () => props.onSignInWithChatGPT());
  }

  async function handleSignOut() {
    await safeAction("signout", () => props.onSignOutCodex());
  }

  function setDefaultProvider(id: string) {
    const provider = PROVIDERS.find((p) => p.id === id);
    if (!provider) return;
    const next: DefaultsState = {
      provider: provider.id,
      model: provider.models[0]?.id ?? defaults.model,
    };
    setDefaults(next);
    writeDefaults(next);
  }

  function setDefaultModel(model: string) {
    const next: DefaultsState = { ...defaults, model };
    setDefaults(next);
    writeDefaults(next);
  }

  const isExperimental = active.id !== "openai" && active.id !== "gateway";

  return (
    <SettingsSection
      title="模型"
      description="配置模型提供商与对应的 API Key。每个智能体可在「模型」字段选择具体模型并按需覆盖。"
    >
      <div className="provider-grid">
        <ul className="provider-list" role="listbox" aria-label="模型提供商">
          {PROVIDERS.map((p) => {
            const s =
              p.id === "openai"
                ? apiKey?.state === "set"
                : p.id === "gateway"
                ? codex?.state === "signed_in"
                : localState[p.id]?.configured;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={p.id === activeId}
                  className={"provider-row" + (p.id === activeId ? " active" : "")}
                  onClick={() => setActiveId(p.id)}
                >
                  <span
                    className="provider-mark"
                    style={{ background: p.tint, color: p.fg }}
                  >
                    {p.glyph}
                  </span>
                  <span className="provider-text">
                    <span className="provider-name">{p.name}</span>
                    <span className="provider-domain">{p.domain}</span>
                  </span>
                  <span
                    className={"provider-dot" + (s ? " on" : "")}
                    title={s ? "已配置" : "未配置"}
                    aria-hidden="true"
                  />
                </button>
              </li>
            );
          })}
        </ul>

        <section className="provider-detail">
          <header className="provider-detail-head">
            <span
              className="provider-mark provider-mark-lg"
              style={{ background: active.tint, color: active.fg }}
            >
              {active.glyph}
            </span>
            <div className="provider-detail-title">
              <h3>{active.name}</h3>
              <span className="provider-detail-domain">{active.domain}</span>
            </div>
            <ProviderStatusPill status={status} internal={!!active.internal} />
          </header>

          {isExperimental ? (
            <div className="provider-banner">
              <span>该提供方仅作 UI 配置预览，后端连接尚未开通；保存的密钥仅在本机记一个标记，不会真正用于推理。</span>
            </div>
          ) : null}

          {/* API Key field — provider-specific behaviour */}
          {active.id === "gateway" ? (
            <CodexBlock
              codex={codex ?? null}
              onSignIn={handleSignIn}
              onSignOut={handleSignOut}
              busy={busy}
            />
          ) : editing ? (
            <FormRow
              label="API Key"
              hint={
                active.id === "openai"
                  ? "存储在系统 keychain，仅当登录 ChatGPT 失败时使用。"
                  : "本机仅保留尾 4 位以便识别；当前 UI 阶段不会上传。"
              }
            >
              <div className="provider-key-edit">
                <input
                  type="password"
                  className="provider-key-input"
                  placeholder={active.placeholder}
                  value={draftKey}
                  onChange={(e) => setDraftKey(e.target.value)}
                  autoComplete="off"
                  spellCheck="false"
                />
                <button
                  type="button"
                  className="btn-primary btn-sm"
                  onClick={handleSave}
                  disabled={!draftKey.trim() || busy !== null}
                >
                  {busy === "save" ? "..." : "保存"}
                </button>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => {
                    setEditing(false);
                    setDraftKey("");
                  }}
                >
                  取消
                </button>
              </div>
            </FormRow>
          ) : (
            <FormRow
              label="API Key"
              hint={
                active.id === "openai"
                  ? "存储在系统 keychain。已登录 ChatGPT 时无需 API Key。"
                  : "本机仅保留尾 4 位以便识别；当前 UI 阶段不会上传。"
              }
            >
              <div className="provider-key-display">
                <span className="provider-key-masked">
                  {status.kind === "configured" ? status.suffix : <em className="provider-key-empty">未填写</em>}
                </span>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={() => setEditing(true)}
                  disabled={busy !== null}
                >
                  {status.kind === "configured" ? "更换" : "添加密钥"}
                </button>
                {status.kind === "configured" ? (
                  <button
                    type="button"
                    className="btn-secondary btn-sm btn-danger-ghost"
                    onClick={handleClear}
                    disabled={busy !== null}
                  >
                    {busy === "clear" ? "..." : "移除"}
                  </button>
                ) : null}
              </div>
            </FormRow>
          )}

          {/* Custom endpoint — local-only knob */}
          {!active.internal ? (
            <FormRow label="自定义 Endpoint" hint="留空则使用官方默认地址。">
              <input
                type="text"
                className="provider-text-input"
                placeholder={`https://${active.domain}`}
                defaultValue={localState[active.id]?.endpoint ?? ""}
                spellCheck="false"
                onBlur={(e) => {
                  const endpoint = e.currentTarget.value.trim();
                  const next: LocalProviderState = {
                    ...(localState[active.id] ?? { configured: false }),
                    endpoint: endpoint || undefined,
                  };
                  writeLocalProvider(active.id, next);
                  setLocalState((prev) => ({ ...prev, [active.id]: next }));
                }}
              />
            </FormRow>
          ) : null}

          <div className="provider-models">
            <div className="provider-models-head">
              <span>支持的模型</span>
              <span className="provider-models-count">{active.models.length} 个</span>
            </div>
            <ul className="provider-models-list">
              {active.models.map((m) => (
                <li key={m.id} className="provider-model-row">
                  <span className="provider-model-name">{m.id}</span>
                  <span className="provider-model-meta">{m.hint}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>

      <section className="provider-defaults">
        <h3 className="provider-defaults-title">默认值</h3>
        <div className="provider-defaults-grid">
          <FormRow label="默认提供方" hint="新建对话时默认使用。">
            <select
              className="provider-select"
              value={defaults.provider}
              onChange={(e) => setDefaultProvider(e.currentTarget.value)}
            >
              {PROVIDERS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </FormRow>
          <FormRow label="默认模型">
            <select
              className="provider-select"
              value={defaults.model}
              onChange={(e) => setDefaultModel(e.currentTarget.value)}
            >
              {(PROVIDERS.find((p) => p.id === defaults.provider) ?? PROVIDERS[0]!).models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}
                </option>
              ))}
            </select>
          </FormRow>
        </div>
      </section>
    </SettingsSection>
  );
}

type ProviderStatus =
  | { kind: "empty" }
  | { kind: "configured"; suffix: string; source?: string }
  | { kind: "expired"; suffix: string };

function ProviderStatusPill({
  status,
  internal,
}: {
  status: ProviderStatus;
  internal: boolean;
}) {
  if (status.kind === "configured") {
    return (
      <span className="provider-status on">
        {internal ? "内置已就绪" : "已配置"}
      </span>
    );
  }
  if (status.kind === "expired") {
    return <span className="provider-status warn">凭据过期</span>;
  }
  return <span className="provider-status off">未配置</span>;
}

function FormRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="form-row">
      <div className="form-row-label">
        <span>{label}</span>
        {hint ? <span className="form-row-hint">{hint}</span> : null}
      </div>
      <div className="form-row-control">{children}</div>
    </div>
  );
}

function CodexBlock({
  codex,
  onSignIn,
  onSignOut,
  busy,
}: {
  codex: NonNullable<SettingsPageProps["authStatus"]>["codex"] | null;
  onSignIn: () => Promise<void>;
  onSignOut: () => Promise<void>;
  busy: "save" | "clear" | "signin" | "signout" | null;
}) {
  const expiresInMin = codex?.expiresAt
    ? Math.max(0, Math.floor((codex.expiresAt - Date.now()) / 60_000))
    : null;
  return (
    <FormRow
      label="ChatGPT 订阅"
      hint="使用 ChatGPT 订阅省去 API Key 按 token 计费。"
    >
      {!codex || codex.state === "not_signed_in" ? (
        <button
          type="button"
          className="btn-primary btn-sm"
          disabled={busy !== null}
          onClick={() => void onSignIn()}
        >
          {busy === "signin" ? "正在打开浏览器…" : "用 ChatGPT 登录"}
        </button>
      ) : codex.state === "signed_in" ? (
        <div className="provider-key-display">
          <span className="provider-key-masked">
            {codex.email ?? "已登录"}
          </span>
          {expiresInMin !== null ? (
            <em className="provider-key-empty">{expiresInMin} 分钟后过期</em>
          ) : null}
          <button
            type="button"
            className="btn-secondary btn-sm"
            disabled={busy !== null}
            onClick={() => void onSignOut()}
          >
            {busy === "signout" ? "..." : "退出登录"}
          </button>
        </div>
      ) : codex.state === "expired" ? (
        <div className="provider-key-display">
          <span className="provider-key-masked">凭据已过期</span>
          {codex.email ? <em className="provider-key-empty">{codex.email}</em> : null}
          <button
            type="button"
            className="btn-primary btn-sm"
            disabled={busy !== null}
            onClick={() => void onSignIn()}
          >
            {busy === "signin" ? "正在打开浏览器…" : "重新登录"}
          </button>
        </div>
      ) : (
        <span className="provider-key-empty">等待浏览器完成登录…</span>
      )}
    </FormRow>
  );
}
