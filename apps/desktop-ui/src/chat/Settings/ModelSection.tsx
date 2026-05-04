import { useEffect, useMemo, useState, type ReactNode } from "react";
import type {
  AuthProfileView,
  ModelProviderView,
  ModelSettingsResponse,
  ModelTestResult,
} from "../../api/modelSettings";
import { ErrorAlert } from "../components";
import { SettingsSection } from "./SettingsSection";
import type { SettingsPageProps } from "./types";

type BusyAction = "save" | "clear" | "signin" | "signout" | "test" | null;

export function ModelSection(props: SettingsPageProps) {
  const [settings, setSettings] = useState<ModelSettingsResponse | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [activeId, setActiveId] = useState("openai");
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [busy, setBusy] = useState<BusyAction>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ModelTestResult | null>(null);

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
    setActionError(null);
    setTestResult(null);
  }, [activeId]);

  const configuredCount = useMemo(
    () => providers.filter((provider) => provider.authProfiles.some(isConfigured)).length,
    [providers],
  );

  async function safeAction<T>(label: NonNullable<BusyAction>, fn: () => Promise<T>): Promise<boolean> {
    setBusy(label);
    setActionError(null);
    try {
      await fn();
      const next = await props.onGetModelSettings().catch(() => settings);
      if (next) setSettings(next);
      return true;
    } catch (cause) {
      setActionError(formatActionError(cause));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function handleSaveApiKey() {
    const key = draftKey.trim();
    console.info("[model-auth] save clicked", {
      editingProfileId,
      keyLength: key.length,
      busy,
    });
    if (!key || !editingProfileId) {
      console.warn("[model-auth] save aborted (missing key or profile)");
      return;
    }
    const ok = await safeAction("save", () => props.onSaveApiKey(editingProfileId, key));
    console.info("[model-auth] save result", { ok });
    if (!ok) return;
    setEditingProfileId(null);
    setDraftKey("");
  }

  async function handleClearApiKey(profileId: string) {
    await safeAction("clear", () => props.onClearApiKey(profileId));
  }

  async function handleSignIn() {
    await safeAction("signin", () => props.onSignInWithChatGPT());
  }

  async function handleSignOut() {
    await safeAction("signout", () => props.onSignOutCodex());
  }

  async function handleTestConnectivity() {
    if (!active) return;
    const firstModel = active.models[0];
    if (!firstModel) {
      setTestResult({
        ok: false,
        provider: active.id,
        model: "",
        message: "该提供方没有可用模型，无法测试。",
      });
      return;
    }
    setBusy("test");
    setActionError(null);
    setTestResult(null);
    try {
      const result = await props.onTestModelConnectivity({ modelRef: firstModel.modelRef });
      setTestResult(result);
    } catch (cause) {
      console.error("[model-auth] test connectivity failed", { cause });
      setTestResult({
        ok: false,
        provider: active.id,
        model: firstModel.modelRef,
        message: formatActionError(cause),
      });
    } finally {
      setBusy(null);
    }
  }

  return (
    <SettingsSection
      title="模型"
      description="配置模型提供商与连接方式。OpenAI API Key 与 ChatGPT/Codex 登录会合并在同一个 OpenAI 提供方下。"
    >
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
                          {provider.models.length} 模型 · {availableProfiles}/{provider.authProfiles.length} 连接
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
              <div className="provider-section-head">
                <span>连接方式</span>
                <span>{active.authProfiles.length} 个</span>
              </div>
              <ErrorAlert message={actionError} />
              {active.authProfiles.some(isConfigured) ? (
                <div className="provider-test-row">
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    disabled={busy !== null}
                    onClick={handleTestConnectivity}
                    aria-label="测试连通性"
                  >
                    {busy === "test" ? "测试中…" : "测试连通性"}
                  </button>
                  {testResult ? (
                    <span
                      role="status"
                      className={
                        "provider-test-feedback " +
                        (testResult.ok ? "provider-test-feedback-ok" : "provider-test-feedback-fail")
                      }
                    >
                      {testResult.ok ? "✓ " : "✗ "}{testResult.message}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {active.authProfiles.map((profile) => (
                <AuthProfileRow
                  key={profile.id}
                  profile={profile}
                  editing={editingProfileId === profile.id}
                  draftKey={draftKey}
                  busy={busy}
                  onEdit={() => {
                    console.info("[model-auth] edit clicked", {
                      profileId: profile.id,
                      provider: profile.provider,
                      currentEditingProfileId: editingProfileId,
                      busy,
                    });
                    setEditingProfileId(profile.id);
                  }}
                  onDraftKey={setDraftKey}
                  onSaveApiKey={handleSaveApiKey}
                  onCancelEdit={() => {
                    setEditingProfileId(null);
                    setDraftKey("");
                  }}
                  onClearApiKey={() => handleClearApiKey(profile.id)}
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
                    <span className="provider-model-ref">{model.modelRef}</span>
                    <span className="provider-model-tags" aria-label={`${model.name} 能力`}>
                      <span className={"provider-model-tag" + (model.reasoning ? " strong" : "")}>
                        {model.reasoning ? "推理" : "快速"}
                      </span>
                      {model.input.map((input) => (
                        <span key={input} className="provider-model-tag">{inputLabel(input)}</span>
                      ))}
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

function formatActionError(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (cause instanceof Error) return cause.message;
  if (cause && typeof cause === "object") {
    const record = cause as { message?: unknown };
    if (typeof record.message === "string") return record.message;
    try {
      return JSON.stringify(cause);
    } catch {
      return String(cause);
    }
  }
  return String(cause);
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
  const canEditApiKey = profile.mode === "api_key";
  const canUseCodexOauth = profile.id === "codex";
  const identity = profileIdentity(profile);

  if (editing && canEditApiKey) {
    return (
      <div className="provider-connection-row editing">
        <div className="provider-connection-main">
          <span className="provider-connection-title">{profile.label}</span>
          <span className="provider-connection-desc">存储在系统 keychain。</span>
          <input
            type="password"
            className="provider-key-input"
            placeholder="sk-..."
            value={draftKey}
            onChange={(event) => onDraftKey(event.target.value)}
            aria-label={`${profile.label} API Key`}
            autoComplete="off"
            spellCheck="false"
          />
        </div>
        <div className="provider-connection-fields" aria-label={`${profile.label} 连接信息`}>
          <ConnectionField label="类型" value={profileModeLabel(profile.mode)} />
          <ConnectionField label="状态" value={statusLabel(profile.status)} tone={statusClass(profile.status)} />
        </div>
        <div className="provider-connection-actions">
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
      </div>
    );
  }

  return (
    <div className="provider-connection-row">
      <div className="provider-connection-main">
        <span className="provider-connection-title">{profile.label}</span>
        <span className="provider-connection-desc">{profileHint(profile)}</span>
        {identity ? (
          <span className="provider-connection-identity">{identity}</span>
        ) : null}
      </div>
      <div className="provider-connection-fields" aria-label={`${profile.label} 连接信息`}>
        <ConnectionField label="类型" value={profileModeLabel(profile.mode)} />
        <ConnectionField label="状态" value={statusLabel(profile.status)} tone={statusClass(profile.status)} />
      </div>
      <div className="provider-connection-actions">
        {canUseCodexOauth ? (
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
        {canEditApiKey ? (
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
    </div>
  );
}

function ConnectionField({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <span className="provider-connection-field">
      <span>{label}</span>
      <b className={tone ? `provider-connection-value ${tone}` : "provider-connection-value"}>{value}</b>
    </span>
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
  if (profile.mode === "oauth") return "通过订阅或授权会话连接。";
  if (profile.mode === "api_key") return "使用静态 API Key 连接。";
  if (profile.mode === "token") return "使用 Bearer Token 连接。";
  return "无需凭据即可连接。";
}

function profileModeLabel(mode: AuthProfileView["mode"]): string {
  if (mode === "api_key") return "API Key";
  if (mode === "oauth") return "OAuth";
  if (mode === "token") return "Token";
  return "无";
}

function profileIdentity(profile: AuthProfileView): ReactNode {
  if (profile.email) return profile.email;
  if (profile.expiresAt) return new Date(profile.expiresAt).toLocaleString();
  return null;
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

function inputLabel(input: string): string {
  if (input === "text") return "文本";
  if (input === "image") return "图像";
  if (input === "audio") return "音频";
  if (input === "video") return "视频";
  if (input === "document") return "文档";
  return "其他";
}

function providerGlyph(providerId: string): string {
  if (providerId === "openai") return "O";
  if (providerId === "anthropic") return "A";
  if (providerId === "google") return "G";
  return providerId.slice(0, 1).toUpperCase();
}

function providerMarkStyle(providerId: string) {
  if (providerId === "anthropic") {
    return { background: "rgba(160, 67, 24, 0.10)", color: "#a04318" };
  }
  if (providerId === "openai") {
    return { background: "rgba(16, 107, 61, 0.10)", color: "#0a6b3d" };
  }
  if (providerId === "google") {
    return { background: "rgba(26, 115, 232, 0.10)", color: "#1a73e8" };
  }
  return { background: "rgba(120,120,120,0.10)", color: "#666" };
}
