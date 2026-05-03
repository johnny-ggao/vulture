import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  AuthProfileView,
  ModelProviderView,
  ModelSettingsResponse,
} from "../../api/modelSettings";
import { SettingsSection } from "./SettingsSection";
import type { SettingsPageProps } from "./types";

type BusyAction = "save" | "clear" | "signin" | "signout" | null;

export function ModelSection(props: SettingsPageProps) {
  const [settings, setSettings] = useState<ModelSettingsResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [activeId, setActiveId] = useState("openai");
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [busy, setBusy] = useState<BusyAction>(null);

  useEffect(() => {
    let cancelled = false;
    props.onGetModelSettings()
      .then((next) => {
        if (!cancelled) {
          setSettings(next);
          setLoadFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSettings({ providers: [] });
          setLoadFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.onGetModelSettings]);

  const providers = settings?.providers ?? [];
  const active = providers.find((provider) => provider.id === activeId) ?? providers[0] ?? null;
  const isLoading = settings === null;

  useEffect(() => {
    if (providers.length === 0) return;
    if (!providers.some((provider) => provider.id === activeId)) {
      setActiveId(providers[0]?.id ?? "openai");
    }
  }, [activeId, providers]);

  useEffect(() => {
    setEditingProfileId(null);
    setDraftKey("");
  }, [activeId]);

  const configuredCount = useMemo(
    () => providers.filter((provider) => provider.authProfiles.some(isConfigured)).length,
    [providers],
  );
  const totalModels = useMemo(
    () => providers.reduce((sum, provider) => sum + provider.models.length, 0),
    [providers],
  );
  const totalProfiles = useMemo(
    () => providers.reduce((sum, provider) => sum + provider.authProfiles.length, 0),
    [providers],
  );
  const configuredProfiles = useMemo(
    () => providers.reduce(
      (sum, provider) => sum + provider.authProfiles.filter(isConfigured).length,
      0,
    ),
    [providers],
  );

  async function safeAction<T>(label: NonNullable<BusyAction>, fn: () => Promise<T>) {
    setBusy(label);
    try {
      await fn();
      const next = await props.onGetModelSettings().catch(() => settings);
      if (next) setSettings(next);
    } finally {
      setBusy(null);
    }
  }

  async function handleSaveApiKey() {
    const key = draftKey.trim();
    if (!key) return;
    await safeAction("save", () => props.onSaveApiKey(key));
    setEditingProfileId(null);
    setDraftKey("");
  }

  async function handleClearApiKey() {
    await safeAction("clear", () => props.onClearApiKey());
  }

  async function handleSignIn() {
    await safeAction("signin", () => props.onSignInWithChatGPT());
  }

  async function handleSignOut() {
    await safeAction("signout", () => props.onSignOutCodex());
  }

  return (
    <SettingsSection
      title="模型"
      description="配置模型提供商与连接方式。OpenAI API Key 与 ChatGPT/Codex 登录会合并在同一个 OpenAI 提供方下。"
    >
      <div className="provider-summary-strip" aria-label="模型配置摘要" aria-live="polite">
        <span><b>{configuredCount}</b> / {providers.length} 已配置</span>
        <span>{providers.length} 个提供方</span>
        <span>{totalModels} 个模型</span>
        <span>{configuredProfiles} / {totalProfiles} 个连接可用</span>
        <span>当前查看 <b>{active?.name ?? "无"}</b></span>
      </div>

      {isLoading ? (
        <div className="provider-banner provider-banner-neutral" role="status">
          <span className="provider-banner-mark" aria-hidden="true" />
          <span>正在加载模型目录…</span>
        </div>
      ) : providers.length === 0 || !active ? (
        <div className="provider-banner">
          <span className="provider-banner-mark" aria-hidden="true" />
          <span>{loadFailed ? "暂时无法加载模型目录。" : "没有可用的模型提供方。"}</span>
        </div>
      ) : (
        <div className="provider-grid">
          <aside className="provider-sidebar">
            <div className="provider-sidebar-head">
              <span>模型提供商</span>
              <span>{configuredCount} 已配置</span>
            </div>
            <ul className="provider-list" role="listbox" aria-label="模型提供商">
              {providers.map((provider) => {
                const configured = provider.authProfiles.some(isConfigured);
                const availableProfiles = provider.authProfiles.filter(isConfigured).length;
                return (
                  <li key={provider.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={provider.id === active.id}
                      className={"provider-row" + (provider.id === active.id ? " active" : "")}
                      onClick={() => setActiveId(provider.id)}
                    >
                      <span
                        className="provider-mark"
                        style={providerMarkStyle(provider.id)}
                      >
                        {providerGlyph(provider.id)}
                      </span>
                      <span className="provider-text">
                        <span className="provider-name">{provider.name}</span>
                        <span className="provider-domain">
                          {provider.models.length} models · {availableProfiles}/{provider.authProfiles.length} auth
                        </span>
                      </span>
                      <span className={"provider-row-status" + (configured ? " on" : "")}>
                        {configured ? "已配置" : "未配置"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>

          <section className="provider-detail">
            <header className="provider-detail-head">
              <span
                className="provider-mark provider-mark-lg"
                style={providerMarkStyle(active.id)}
              >
                {providerGlyph(active.id)}
              </span>
              <div className="provider-detail-title">
                <h3>{active.name}</h3>
                <span className="provider-detail-domain">{active.baseUrl ?? active.api ?? active.id}</span>
              </div>
              <ProviderStatusPill provider={active} />
            </header>

            <div className="provider-detail-metrics" aria-label={`${active.name} 模型连接摘要`}>
              <MetricCell label="模型" value={String(active.models.length)} />
              <MetricCell
                label="可用连接"
                value={`${active.authProfiles.filter(isConfigured).length}/${active.authProfiles.length}`}
              />
              <MetricCell label="接口" value={apiLabel(active.api)} />
              <MetricCell label="默认认证" value={authOrderLabel(active)} />
            </div>

            {active.authOrder.length > 0 ? (
              <div className="provider-auth-order" aria-label="默认连接优先级">
                <span className="provider-auth-order-label">默认优先级</span>
                <div className="provider-auth-order-list">
                  {active.authOrder.map((profileId, index) => {
                    const profile = active.authProfiles.find((item) => item.id === profileId);
                    return (
                      <span
                        key={`${profileId}-${index}`}
                        className={
                          "provider-auth-chip" +
                          (profile?.status === "configured" ? " on" : "") +
                          (profile?.status === "expired" || profile?.status === "error" ? " warn" : "")
                        }
                      >
                        <span>{index + 1}</span>
                        {profile?.label ?? profileId}
                      </span>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <div className="provider-form-stack">
              {active.authProfiles.map((profile) => (
                <AuthProfileRow
                  key={profile.id}
                  profile={profile}
                  editing={editingProfileId === profile.id}
                  draftKey={draftKey}
                  busy={busy}
                  onEdit={() => setEditingProfileId(profile.id)}
                  onDraftKey={setDraftKey}
                  onSaveApiKey={handleSaveApiKey}
                  onCancelEdit={() => {
                    setEditingProfileId(null);
                    setDraftKey("");
                  }}
                  onClearApiKey={handleClearApiKey}
                  onSignIn={handleSignIn}
                  onSignOut={handleSignOut}
                />
              ))}
            </div>

            <div className="provider-models">
              <div className="provider-models-head">
                <span>支持的模型</span>
                <span className="provider-models-count">{active.models.length} 个</span>
              </div>
              <ul className="provider-models-list">
                {active.models.map((model) => (
                  <li key={model.modelRef} className="provider-model-row">
                    <span className="provider-model-name">{model.name}</span>
                    <span className="provider-model-meta">
                      <span>{model.modelRef}</span>
                      <span>{model.reasoning ? "推理" : "快速"} · {model.input.join(" / ")}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </div>
      )}
    </SettingsSection>
  );
}

function MetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="provider-metric-cell">
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function AuthProfileRow({
  profile,
  editing,
  draftKey,
  busy,
  onEdit,
  onDraftKey,
  onSaveApiKey,
  onCancelEdit,
  onClearApiKey,
  onSignIn,
  onSignOut,
}: {
  profile: AuthProfileView;
  editing: boolean;
  draftKey: string;
  busy: BusyAction;
  onEdit: () => void;
  onDraftKey: (next: string) => void;
  onSaveApiKey: () => void;
  onCancelEdit: () => void;
  onClearApiKey: () => void;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  if (editing && profile.id === "openai-api-key") {
    return (
      <FormRow label={profile.label} hint="存储在系统 keychain。">
        <div className="provider-key-edit">
          <input
            type="password"
            className="provider-key-input"
            placeholder="sk-..."
            value={draftKey}
            onChange={(event) => onDraftKey(event.target.value)}
            autoComplete="off"
            spellCheck="false"
          />
          <button
            type="button"
            className="btn-primary btn-sm"
            onClick={onSaveApiKey}
            disabled={!draftKey.trim() || busy !== null}
          >
            {busy === "save" ? "..." : "保存"}
          </button>
          <button type="button" className="btn-secondary btn-sm" onClick={onCancelEdit}>
            取消
          </button>
        </div>
      </FormRow>
    );
  }

  return (
    <FormRow label={profile.label} hint={profileHint(profile)}>
      <div className="provider-key-display">
        <span className="provider-profile-mode">{profileModeLabel(profile.mode)}</span>
        <span className="provider-key-masked">{profileDisplay(profile)}</span>
        <span className={"provider-status " + statusClass(profile.status)}>
          {statusLabel(profile.status)}
        </span>
        {profile.id === "codex" ? (
          profile.status === "configured" ? (
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={busy !== null}
              onClick={onSignOut}
            >
              {busy === "signout" ? "..." : "退出登录"}
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary btn-sm"
              disabled={busy !== null}
              onClick={onSignIn}
            >
              {busy === "signin" ? "登录中…" : profile.status === "expired" ? "重新登录" : "登录 ChatGPT"}
            </button>
          )
        ) : null}
        {profile.id === "openai-api-key" ? (
          <>
            <button
              type="button"
              className="btn-secondary btn-sm"
              disabled={busy !== null}
              onClick={onEdit}
            >
              {profile.status === "configured" ? "更换" : "添加密钥"}
            </button>
            {profile.status === "configured" ? (
              <button
                type="button"
                className="btn-secondary btn-sm btn-danger-ghost"
                disabled={busy !== null}
                onClick={onClearApiKey}
              >
                {busy === "clear" ? "..." : "移除"}
              </button>
            ) : null}
          </>
        ) : null}
      </div>
    </FormRow>
  );
}

function FormRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
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

function ProviderStatusPill({ provider }: { provider: ModelProviderView }) {
  const status = provider.authProfiles.some(isConfigured) ? "configured" : "missing";
  return (
    <span className={"provider-status " + (status === "configured" ? "on" : "off")}>
      {status === "configured" ? "已配置" : "未配置"}
    </span>
  );
}

function apiLabel(api?: string): string {
  if (api === "openai-responses") return "Responses";
  if (api === "openai-codex-responses") return "Codex";
  if (api === "anthropic-messages") return "Messages";
  return api ?? "默认";
}

function authOrderLabel(provider: ModelProviderView): string {
  const first = provider.authProfiles.find((profile) => profile.id === provider.authOrder[0]);
  if (!first) return "未设置";
  return first.label;
}

function isConfigured(profile: AuthProfileView): boolean {
  return profile.status === "configured";
}

function profileHint(profile: AuthProfileView): string {
  if (profile.message) return profile.message;
  if (profile.mode === "oauth") return "OAuth / subscription-backed connection";
  if (profile.mode === "api_key") return "Static credential connection";
  if (profile.mode === "token") return "Token-backed connection";
  return "No credential required";
}

function profileModeLabel(mode: AuthProfileView["mode"]): string {
  if (mode === "api_key") return "API Key";
  if (mode === "oauth") return "OAuth";
  if (mode === "token") return "Token";
  return "None";
}

function profileDisplay(profile: AuthProfileView): ReactNode {
  if (profile.email) return profile.email;
  if (profile.expiresAt) return new Date(profile.expiresAt).toLocaleString();
  return <em className="provider-key-empty">{profile.status}</em>;
}

function statusLabel(status: AuthProfileView["status"]): string {
  switch (status) {
    case "configured":
      return "已配置";
    case "expired":
      return "已过期";
    case "unsupported":
      return "未接入";
    case "error":
      return "错误";
    case "missing":
      return "未配置";
  }
}

function statusClass(status: AuthProfileView["status"]): string {
  if (status === "configured") return "on";
  if (status === "expired" || status === "error") return "warn";
  return "off";
}

function providerGlyph(providerId: string): string {
  if (providerId === "openai") return "O";
  if (providerId === "anthropic") return "A";
  return providerId.slice(0, 1).toUpperCase();
}

function providerMarkStyle(providerId: string) {
  if (providerId === "anthropic") {
    return { background: "rgba(160, 67, 24, 0.10)", color: "#a04318" };
  }
  if (providerId === "openai") {
    return { background: "rgba(16, 107, 61, 0.10)", color: "#0a6b3d" };
  }
  return { background: "rgba(120,120,120,0.10)", color: "#666" };
}
