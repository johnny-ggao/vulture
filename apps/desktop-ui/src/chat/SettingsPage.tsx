import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AuthStatusView, BrowserRelayStatus } from "../commandCenterTypes";
import type { Agent } from "../api/agents";
import type { Memory, MemorySuggestion } from "../api/memories";

const SECTIONS = [
  { key: "general",  label: "通用",       icon: <DotIcon /> },
  { key: "model",    label: "模型",       icon: <DotIcon /> },
  { key: "memory",   label: "记忆",       icon: <DotIcon /> },
  { key: "mcp",      label: "MCP 服务器", icon: <DotIcon /> },
  { key: "browser",  label: "浏览器",     icon: <DotIcon /> },
  { key: "channels", label: "消息渠道",   icon: <DotIcon /> },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];

export interface SettingsPageProps {
  authStatus: AuthStatusView | null;
  browserStatus: BrowserRelayStatus | null;
  agents: ReadonlyArray<Agent>;
  selectedAgentId: string;
  profiles: Array<{ id: string; name: string; activeAgentId: string }>;
  activeProfileId: string | null;
  switchingProfileId: string | null;
  onSelectAgent: (agentId: string) => void;
  onListMemories: (agentId: string) => Promise<Memory[]>;
  onCreateMemory: (agentId: string, content: string) => Promise<Memory>;
  onDeleteMemory: (agentId: string, memoryId: string) => Promise<void>;
  onListMemorySuggestions: (agentId: string) => Promise<MemorySuggestion[]>;
  onAcceptMemorySuggestion: (agentId: string, suggestionId: string) => Promise<MemorySuggestion>;
  onDismissMemorySuggestion: (agentId: string, suggestionId: string) => Promise<MemorySuggestion>;
  onCreateProfile: (name: string) => Promise<void>;
  onSwitchProfile: (profileId: string) => Promise<void>;
  onSignInWithChatGPT: () => Promise<void>;
  onSignOutCodex: () => Promise<void>;
  onSaveApiKey: (apiKey: string) => Promise<void>;
  onClearApiKey: () => Promise<void>;
  onStartBrowserPairing: () => Promise<void>;
}

export function SettingsPage(props: SettingsPageProps) {
  const [section, setSection] = useState<SectionKey>("general");
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>设置</h1>
          <p>偏好、模型、记忆与连接器。MCP / 消息渠道分区仍为后续预留。</p>
        </div>
      </header>
      <div className="settings-layout">
        <aside className="settings-rail" aria-label="设置分区">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              className={section === s.key ? "active" : ""}
              onClick={() => setSection(s.key)}
            >
              {s.icon}
              <span>{s.label}</span>
            </button>
          ))}
        </aside>
        <div className="settings-content">{renderSection(section, props)}</div>
      </div>
    </div>
  );
}

function renderSection(section: SectionKey, props: SettingsPageProps): ReactNode {
  switch (section) {
    case "general":  return <GeneralSection {...props} />;
    case "model":    return <ModelSection {...props} />;
    case "memory":   return <MemorySection {...props} />;
    case "mcp":      return <Stub title="MCP 服务器" body="挂载 Model Context Protocol 服务器。Phase 4 启用。" />;
    case "browser":  return <BrowserSection {...props} />;
    case "channels": return <Stub title="消息渠道" body="向微信、飞书等渠道转发会话事件。Phase 4 启用。" />;
  }
}

function MemorySection(props: SettingsPageProps) {
  const activeAgent = useMemo(
    () => props.agents.find((agent) => agent.id === props.selectedAgentId) ?? props.agents[0],
    [props.agents, props.selectedAgentId],
  );
  const [items, setItems] = useState<Memory[]>([]);
  const [suggestions, setSuggestions] = useState<MemorySuggestion[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(agentId: string) {
    setError(null);
    try {
      setItems(await props.onListMemories(agentId));
      setSuggestions(await props.onListMemorySuggestions(agentId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  useEffect(() => {
    if (!activeAgent) {
      setItems([]);
      setSuggestions([]);
      return;
    }
    void load(activeAgent.id);
  }, [activeAgent?.id]);

  async function create() {
    const content = draft.trim();
    if (!activeAgent || !content || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onCreateMemory(activeAgent.id, content);
      await load(activeAgent.id);
      setDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function acceptSuggestion(suggestion: MemorySuggestion) {
    if (!activeAgent || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onAcceptMemorySuggestion(activeAgent.id, suggestion.id);
      setSuggestions((prev) => prev.filter((item) => item.id !== suggestion.id));
      await load(activeAgent.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function dismissSuggestion(suggestion: MemorySuggestion) {
    if (!activeAgent || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onDismissMemorySuggestion(activeAgent.id, suggestion.id);
      setSuggestions((prev) => prev.filter((item) => item.id !== suggestion.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(memory: Memory) {
    if (!activeAgent || busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onDeleteMemory(activeAgent.id, memory.id);
      setItems((prev) => prev.filter((item) => item.id !== memory.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-card">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "end", marginBottom: 14 }}>
        <div>
          <h3>Agent 记忆</h3>
          <p style={{ color: "var(--text-secondary)", marginTop: 4 }}>Markdown 文件是长期记忆源，索引用于检索与工具读取。</p>
        </div>
        <label style={{ display: "grid", gap: 6, minWidth: 220, color: "var(--text-secondary)", fontSize: 12 }}>
          <span>智能体</span>
          <select
            aria-label="记忆智能体"
            value={activeAgent?.id ?? ""}
            onChange={(event) => props.onSelectAgent(event.target.value)}
          >
            {props.agents.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div style={{ display: "grid", gap: 8, marginBottom: 16 }}>
        <textarea
          aria-label="新增记忆"
          rows={3}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="例如：用户喜欢简洁中文回答"
        />
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || !draft.trim() || !activeAgent}
            onClick={create}
          >
            {busy ? "处理中..." : "添加记忆"}
          </button>
        </div>
      </div>

      {error ? <div style={{ color: "var(--danger)", marginBottom: 12 }}>{error}</div> : null}

      {suggestions.length > 0 ? (
        <div style={{ display: "grid", gap: 10, marginBottom: 16 }}>
          <h4 style={{ margin: 0, fontSize: 14 }}>待确认记忆</h4>
          {suggestions.map((suggestion) => (
            <article
              key={suggestion.id}
              style={{
                border: "1px solid rgba(15, 15, 15, 0.08)",
                borderRadius: "var(--radius-md)",
                padding: 12,
                display: "grid",
                gap: 8,
              }}
            >
              <div style={{ color: "var(--text-primary)", whiteSpace: "pre-wrap" }}>{suggestion.content}</div>
              <div style={{ color: "var(--text-tertiary)", fontSize: 12 }}>{suggestion.targetPath} · {suggestion.reason}</div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => dismissSuggestion(suggestion)}>忽略</button>
                <button type="button" className="btn-primary" disabled={busy} onClick={() => acceptSuggestion(suggestion)}>接受</button>
              </div>
            </article>
          ))}
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="placeholder" style={{ minHeight: 120 }}>
          <span>当前智能体没有记忆。</span>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {items.map((memory) => (
            <article
              key={memory.id}
              style={{
                border: "1px solid rgba(15, 15, 15, 0.08)",
                borderRadius: "var(--radius-md)",
                padding: 12,
                display: "grid",
                gap: 8,
              }}
            >
              <div style={{ color: "var(--text-primary)", whiteSpace: "pre-wrap" }}>{memory.content}</div>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                <span style={{ color: "var(--text-tertiary)", fontSize: 12 }}>
                  {memory.path ? `${memory.path}${memory.heading ? ` # ${memory.heading}` : ""}` : new Date(memory.updatedAt).toLocaleString()}
                </span>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy}
                  onClick={() => remove(memory)}
                >
                  删除记忆
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function GeneralSection(props: SettingsPageProps) {
  const [profileName, setProfileName] = useState("");
  const [busy, setBusy] = useState(false);

  async function createProfile() {
    const name = profileName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await props.onCreateProfile(name);
      setProfileName("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-card">
        <h3>Profiles</h3>
        <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
          {props.profiles.map((profile) => {
            const active = profile.id === props.activeProfileId;
            const switching = props.switchingProfileId === profile.id;
            return (
              <div
                key={profile.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 12,
                  padding: "9px 0",
                  borderBottom: "1px solid var(--fill-quaternary)",
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{profile.name}</div>
                  <div style={{ color: "var(--text-tertiary)", fontSize: 12 }}>{profile.id}</div>
                </div>
                <button
                  type="button"
                  className={active ? "btn-primary" : "btn-secondary"}
                  disabled={active || props.switchingProfileId !== null}
                  onClick={() => props.onSwitchProfile(profile.id)}
                >
                  {active ? "当前" : switching ? "切换中..." : "切换"}
                </button>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            value={profileName}
            placeholder="Profile name"
            onChange={(event) => setProfileName(event.target.value)}
            style={{
              flex: 1,
              padding: "8px 10px",
              border: "1px solid var(--fill-tertiary)",
              borderRadius: "var(--radius-sm)",
              background: "var(--bg-primary)",
              fontSize: 14,
            }}
          />
          <button
            type="button"
            className="btn-primary"
            disabled={busy || props.switchingProfileId !== null || !profileName.trim()}
            onClick={createProfile}
          >
            {busy ? "..." : "新建并切换"}
          </button>
        </div>
      </div>

      <div className="page-card">
        <h3>通用</h3>
        <p style={{ marginBottom: 12 }}>主题：跟随系统（Phase 4 加入主题切换）</p>
        <p style={{ color: "var(--text-tertiary)", fontSize: 12 }}>当前 UI 版本：Phase 3d 设计刷新</p>
      </div>
    </>
  );
}

function ModelSection(props: SettingsPageProps) {
  const codex = props.authStatus?.codex;
  const apiKey = props.authStatus?.apiKey;
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [busy, setBusy] = useState<"signin" | "signout" | "savekey" | null>(null);

  const expiresInMin = codex?.expiresAt
    ? Math.max(0, Math.floor((codex.expiresAt - Date.now()) / 60_000))
    : null;

  async function safeAction<T>(label: typeof busy, fn: () => Promise<T>) {
    setBusy(label);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="page-card">
        <h3>当前在用</h3>
        <p style={{ color: "var(--text-secondary)" }}>{describeActive(props.authStatus)}</p>
      </div>

      <div className="page-card">
        <h3>ChatGPT 订阅 (推荐)</h3>
        {!codex || codex.state === "not_signed_in" ? (
          <>
            <p style={{ color: "var(--text-secondary)", marginBottom: 10 }}>使用 ChatGPT 订阅省去 API key 按 token 计费。</p>
            <button
              type="button"
              className="btn-primary"
              disabled={busy !== null}
              onClick={() => safeAction("signin", props.onSignInWithChatGPT)}
            >
              {busy === "signin" ? "正在打开浏览器…" : "用 ChatGPT 登录"}
            </button>
          </>
        ) : codex.state === "signed_in" ? (
          <>
            <Row label="状态" value={`已登录${codex.email ? " · " + codex.email : ""}`} />
            {expiresInMin !== null ? <Row label="过期" value={`${expiresInMin} 分钟后`} /> : null}
            {codex.importedFrom ? <Row label="来源" value="Codex CLI 导入" /> : null}
            <button
              type="button"
              className="btn-secondary"
              style={{ marginTop: 12 }}
              disabled={busy !== null}
              onClick={() => safeAction("signout", props.onSignOutCodex)}
            >
              {busy === "signout" ? "..." : "退出登录"}
            </button>
          </>
        ) : codex.state === "expired" ? (
          <>
            <p style={{ color: "var(--danger)", marginBottom: 10 }}>⚠ 凭据已过期</p>
            {codex.email ? <p style={{ color: "var(--text-tertiary)", fontSize: 12, marginBottom: 10 }}>{codex.email}</p> : null}
            <button
              type="button"
              className="btn-primary"
              disabled={busy !== null}
              onClick={() => safeAction("signin", props.onSignInWithChatGPT)}
            >
              {busy === "signin" ? "正在打开浏览器…" : "重新登录"}
            </button>
          </>
        ) : (
          <p>等待浏览器完成登录…</p>
        )}
      </div>

      <div className="page-card">
        <h3>OpenAI API Key (备选)</h3>
        {apiKey?.state === "set" ? (
          <>
            <Row label="状态" value="已配置" />
            <Row label="来源" value={apiKey.source ?? "keychain"} />
            <button
              type="button"
              className="btn-secondary"
              style={{ marginTop: 12 }}
              disabled={busy !== null}
              onClick={() => safeAction("savekey", props.onClearApiKey)}
            >
              清除
            </button>
          </>
        ) : (
          <>
            <p style={{ color: "var(--text-secondary)", marginBottom: 10 }}>仅在未登录 ChatGPT 时使用。按 token 计费。</p>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="password"
                placeholder="sk-..."
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                style={{
                  flex: 1,
                  padding: "8px 10px",
                  border: "1px solid var(--fill-tertiary)",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--bg-primary)",
                  fontSize: 14,
                }}
              />
              <button
                type="button"
                className="btn-primary"
                disabled={busy !== null || !apiKeyInput.trim()}
                onClick={() => safeAction("savekey", async () => {
                  await props.onSaveApiKey(apiKeyInput.trim());
                  setApiKeyInput("");
                })}
              >
                {busy === "savekey" ? "..." : "保存"}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

function BrowserSection(props: SettingsPageProps) {
  const [busy, setBusy] = useState(false);
  const status = props.browserStatus;

  async function startPairing() {
    setBusy(true);
    try {
      await props.onStartBrowserPairing();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-card">
      <h3>浏览器中继 (Browser Relay)</h3>
      <p style={{ color: "var(--text-secondary)", marginBottom: 12 }}>
        通过本地 Chrome 扩展连接桌面浏览器，供 browser.snapshot / browser.click 工具调用。
      </p>
      <Row
        label="状态"
        value={
          status?.paired ? "已连接" :
          status?.enabled ? "等待扩展配对" :
          "未启用"
        }
      />
      {status?.relayPort ? <Row label="端口" value={String(status.relayPort)} /> : null}
      {status?.pairingToken ? (
        <Row
          label="配对令牌"
          value={status.pairingToken}
        />
      ) : null}
      <button
        type="button"
        className="btn-secondary"
        style={{ marginTop: 12 }}
        disabled={busy}
        onClick={startPairing}
      >
        {busy ? "..." : "开始配对"}
      </button>
    </div>
  );
}

function describeActive(s: AuthStatusView | null): string {
  if (!s) return "loading";
  if (s.active === "codex") return `Codex (${s.codex.email ?? "已登录"})`;
  if (s.active === "api_key") return "API Key";
  if (s.codex.state === "expired") return "Codex 已过期，请重新登录";
  return "未认证";
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: "flex",
      justifyContent: "space-between",
      gap: 12,
      padding: "10px 0",
      borderBottom: "1px solid var(--fill-quaternary)",
      fontSize: 13,
    }}>
      <span style={{ color: "var(--text-secondary)" }}>{label}</span>
      <span style={{ color: "var(--text-primary)", fontWeight: 500, fontFamily: value.length > 20 ? "var(--font-mono)" : "inherit", wordBreak: "break-all", textAlign: "right" }}>{value}</span>
    </div>
  );
}

function Stub({ title, body }: { title: string; body: string }) {
  return (
    <div className="page-card">
      <h3>{title}</h3>
      <div className="placeholder">
        <span>{body}</span>
      </div>
    </div>
  );
}

function DotIcon() {
  return <span style={{ width: 6, height: 6, borderRadius: 999, background: "currentColor", opacity: 0.5 }} />;
}
