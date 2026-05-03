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
  const [activeId, setActiveId] = useState("openai");
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [busy, setBusy] = useState<BusyAction>(null);

  useEffect(() => {
    let cancelled = false;
    props.onGetModelSettings()
      .then((next) => {
        if (!cancelled) setSettings(next);
      })
      .catch(() => {
        if (!cancelled) setSettings({ providers: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [props.onGetModelSettings]);

  const providers = settings?.providers ?? [];
  const active = providers.find((provider) => provider.id === activeId) ?? providers[0] ?? null;

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
      <div className="provider-summary-strip" aria-label="模型配置摘要">
        <span><b>{configuredCount}</b> / {providers.length} 已配置</span>
        <span>{providers.length} 个提供方</span>
        <span>当前查看 <b>{active?.name ?? "无"}</b> · {active?.models.length ?? 0} 个模型</span>
      </div>

      {providers.length === 0 || !active ? (
        <div className="provider-banner">
          <span className="provider-banner-mark" aria-hidden="true" />
          <span>暂时无法加载模型目录。</span>
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
                        <span className="provider-domain">{provider.baseUrl ?? provider.api ?? provider.id}</span>
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
                    <span className="provider-model-name">{model.modelRef}</span>
                    <span className="provider-model-meta">
                      {model.reasoning ? "推理" : "快速"} · {model.input.join(" / ")}
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

function isConfigured(profile: AuthProfileView): boolean {
  return profile.status === "configured";
}

function profileHint(profile: AuthProfileView): string {
  if (profile.message) return profile.message;
  if (profile.mode === "oauth") return "OAuth / subscription-backed connection";
  if (profile.mode === "api_key") return "Static credential connection";
  return "Connection profile";
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
