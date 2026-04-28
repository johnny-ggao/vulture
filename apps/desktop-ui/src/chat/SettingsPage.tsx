import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AuthStatusView, BrowserRelayStatus } from "../commandCenterTypes";
import type { Agent } from "../api/agents";
import type { Memory, MemoryStatus } from "../api/memories";
import type {
  McpServer,
  McpToolSummary,
  McpTrust,
  SaveMcpServer,
  UpdateMcpServer,
} from "../api/mcpServers";

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
  onGetMemoryStatus: (agentId: string) => Promise<MemoryStatus | null>;
  onReindexMemory: (agentId: string) => Promise<MemoryStatus>;
  onCreateMemory: (agentId: string, content: string) => Promise<Memory>;
  onDeleteMemory: (agentId: string, memoryId: string) => Promise<void>;
  onListMcpServers: () => Promise<McpServer[]>;
  onCreateMcpServer: (input: SaveMcpServer) => Promise<McpServer>;
  onUpdateMcpServer: (id: string, patch: UpdateMcpServer) => Promise<McpServer>;
  onDeleteMcpServer: (id: string) => Promise<void>;
  onReconnectMcpServer: (id: string) => Promise<McpServer>;
  onListMcpServerTools: (id: string) => Promise<McpToolSummary[]>;
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
    case "mcp":      return <McpSection {...props} />;
    case "browser":  return <BrowserSection {...props} />;
    case "channels": return <Stub title="消息渠道" body="向微信、飞书等渠道转发会话事件。Phase 4 启用。" />;
  }
}

function McpSection(props: SettingsPageProps) {
  const [items, setItems] = useState<McpServer[]>([]);
  const [toolsByServer, setToolsByServer] = useState<Record<string, McpToolSummary[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    id: "",
    name: "",
    command: "",
    args: "",
    cwd: "",
    env: "",
    trust: "ask" as McpTrust,
    enabled: true,
  });

  async function load() {
    setError(null);
    try {
      setItems(await props.onListMcpServers());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function create() {
    if (busy) return;
    setBusy("create");
    setError(null);
    try {
      await props.onCreateMcpServer({
        id: draft.id.trim(),
        name: draft.name.trim(),
        transport: "stdio",
        command: draft.command.trim(),
        args: parseArgs(draft.args),
        cwd: draft.cwd.trim() ? draft.cwd.trim() : null,
        env: parseEnv(draft.env),
        trust: draft.trust,
        enabled: draft.enabled,
      });
      setDraft({
        id: "",
        name: "",
        command: "",
        args: "",
        cwd: "",
        env: "",
        trust: "ask",
        enabled: true,
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function update(server: McpServer, patch: UpdateMcpServer) {
    if (busy) return;
    setBusy(server.id);
    setError(null);
    try {
      const updated = await props.onUpdateMcpServer(server.id, patch);
      setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function reconnect(server: McpServer) {
    if (busy) return;
    setBusy(server.id);
    setError(null);
    try {
      const updated = await props.onReconnectMcpServer(server.id);
      const tools = await props.onListMcpServerTools(server.id);
      setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setToolsByServer((prev) => ({ ...prev, [server.id]: tools }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function loadTools(server: McpServer) {
    if (busy) return;
    setBusy(server.id);
    setError(null);
    try {
      const tools = await props.onListMcpServerTools(server.id);
      setToolsByServer((prev) => ({ ...prev, [server.id]: tools }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  async function toggleTool(server: McpServer, tool: McpToolSummary, enabled: boolean) {
    const currentEnabledTools = getEnabledTools(server);
    const currentDisabledTools = getDisabledTools(server);
    const enabledTools =
      currentEnabledTools === null
        ? null
        : toggleName(currentEnabledTools, tool.name, enabled);
    const disabledTools = enabled
      ? currentDisabledTools.filter((name) => name !== tool.name)
      : [...new Set([...currentDisabledTools, tool.name])];
    await updateToolPolicy(server, { enabledTools, disabledTools });
  }

  async function updateToolPolicy(
    server: McpServer,
    patch: Pick<UpdateMcpServer, "enabledTools" | "disabledTools">,
  ) {
    const updated = await props.onUpdateMcpServer(server.id, patch);
    setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
    const tools = await props.onListMcpServerTools(server.id);
    setToolsByServer((prev) => ({
      ...prev,
      [server.id]: tools.map((tool) => ({ ...tool, enabled: isToolEnabled(updated, tool.name) })),
    }));
  }

  async function applyToolPreset(
    server: McpServer,
    tools: McpToolSummary[],
    preset: "all" | "readonly" | "none",
  ) {
    if (preset === "all") {
      await updateToolPolicy(server, { enabledTools: null, disabledTools: [] });
      return;
    }
    if (preset === "none") {
      await updateToolPolicy(server, { enabledTools: [], disabledTools: [] });
      return;
    }
    await updateToolPolicy(server, {
      enabledTools: tools.filter(isReadOnlyMcpTool).map((tool) => tool.name),
      disabledTools: [],
    });
  }

  async function remove(server: McpServer) {
    if (busy) return;
    setBusy(server.id);
    setError(null);
    try {
      await props.onDeleteMcpServer(server.id);
      setItems((prev) => prev.filter((item) => item.id !== server.id));
      setToolsByServer((prev) => {
        const next = { ...prev };
        delete next[server.id];
        return next;
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  const canCreate = draft.id.trim() && draft.name.trim() && draft.command.trim();

  return (
    <div className="page-card">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "end", marginBottom: 14 }}>
        <div>
          <h3>MCP 服务器</h3>
          <p style={{ color: "var(--text-secondary)", marginTop: 4 }}>本地 stdio MCP server 会作为 agent 工具加载，默认需要审批。</p>
        </div>
        <button type="button" className="btn-secondary" disabled={busy !== null} onClick={load}>
          刷新
        </button>
      </div>

      <div style={{ display: "grid", gap: 10, marginBottom: 16 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <input aria-label="MCP ID" value={draft.id} placeholder="id: echo-server" onChange={(e) => setDraft((v) => ({ ...v, id: e.target.value }))} />
          <input aria-label="MCP 名称" value={draft.name} placeholder="名称" onChange={(e) => setDraft((v) => ({ ...v, name: e.target.value }))} />
        </div>
        <input aria-label="MCP 命令" value={draft.command} placeholder="command: bun" onChange={(e) => setDraft((v) => ({ ...v, command: e.target.value }))} />
        <input aria-label="MCP 参数" value={draft.args} placeholder="args: run server.ts" onChange={(e) => setDraft((v) => ({ ...v, args: e.target.value }))} />
        <input aria-label="MCP 工作目录" value={draft.cwd} placeholder="cwd: /absolute/path，可空" onChange={(e) => setDraft((v) => ({ ...v, cwd: e.target.value }))} />
        <textarea aria-label="MCP 环境变量" rows={3} value={draft.env} placeholder={"env: KEY=value\\nANOTHER=value"} onChange={(e) => setDraft((v) => ({ ...v, env: e.target.value }))} />
        <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between" }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--text-secondary)", fontSize: 13 }}>
            <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft((v) => ({ ...v, enabled: e.target.checked }))} />
            启用
          </label>
          <select aria-label="MCP 信任级别" value={draft.trust} onChange={(e) => setDraft((v) => ({ ...v, trust: e.target.value as McpTrust }))}>
            <option value="ask">ask</option>
            <option value="trusted">trusted</option>
            <option value="disabled">disabled</option>
          </select>
          <button type="button" className="btn-primary" disabled={busy !== null || !canCreate} onClick={create}>
            {busy === "create" ? "添加中..." : "添加服务器"}
          </button>
        </div>
      </div>

      {error ? <div style={{ color: "var(--danger)", marginBottom: 12 }}>{error}</div> : null}

      {items.length === 0 ? (
        <div className="placeholder" style={{ minHeight: 120 }}>
          <span>还没有 MCP 服务器。</span>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {items.map((server) => (
            <article
              key={server.id}
              style={{
                border: "1px solid rgba(15, 15, 15, 0.08)",
                borderRadius: "var(--radius-md)",
                padding: 12,
                display: "grid",
                gap: 10,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "start" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 650 }}>{server.name}</div>
                  <div style={{ color: "var(--text-tertiary)", fontSize: 12, fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
                    {server.id} · {server.command} {server.args.join(" ")}
                  </div>
                </div>
                <StatusPill label={`${server.runtime.status} · tools ${server.runtime.toolCount}`} />
              </div>
              {server.runtime.lastError ? (
                <div style={{ color: "var(--danger)", fontSize: 12, wordBreak: "break-word" }}>{server.runtime.lastError}</div>
              ) : null}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center", color: "var(--text-secondary)", fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={server.enabled}
                    disabled={busy !== null}
                    onChange={(e) => update(server, { enabled: e.target.checked })}
                  />
                  启用
                </label>
                <select
                  aria-label={`${server.name} trust`}
                  value={server.trust}
                  disabled={busy !== null}
                  onChange={(e) => update(server, { trust: e.target.value as McpTrust })}
                >
                  <option value="ask">ask</option>
                  <option value="trusted">trusted</option>
                  <option value="disabled">disabled</option>
                </select>
                <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => reconnect(server)}>
                  {busy === server.id ? "处理中..." : "重连"}
                </button>
                <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => loadTools(server)}>
                  工具
                </button>
                <button type="button" className="btn-secondary" disabled={busy !== null} onClick={() => remove(server)}>
                  删除
                </button>
              </div>
              {toolsByServer[server.id]?.length ? (
                <div style={{ display: "grid", gap: 6 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busy !== null}
                      onClick={() => {
                        setBusy(server.id);
                        setError(null);
                        applyToolPreset(server, toolsByServer[server.id], "all")
                          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                          .finally(() => setBusy(null));
                      }}
                    >
                      全部开启
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busy !== null}
                      onClick={() => {
                        setBusy(server.id);
                        setError(null);
                        applyToolPreset(server, toolsByServer[server.id], "readonly")
                          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                          .finally(() => setBusy(null));
                      }}
                    >
                      只读
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busy !== null}
                      onClick={() => {
                        setBusy(server.id);
                        setError(null);
                        applyToolPreset(server, toolsByServer[server.id], "none")
                          .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                          .finally(() => setBusy(null));
                      }}
                    >
                      全部关闭
                    </button>
                  </div>
                  {toolsByServer[server.id].map((tool) => (
                    <label
                      key={tool.name}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "auto minmax(0, 1fr)",
                        gap: 8,
                        alignItems: "start",
                        color: "var(--text-secondary)",
                        fontSize: 12,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={tool.enabled ?? isToolEnabled(server, tool.name)}
                        disabled={busy !== null}
                        onChange={(e) => {
                          setBusy(server.id);
                          setError(null);
                          toggleTool(server, tool, e.target.checked)
                            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
                            .finally(() => setBusy(null));
                        }}
                      />
                      <span>
                        <span style={{ fontFamily: "var(--font-mono)", color: "var(--text-primary)" }}>{tool.name}</span>
                        {tool.description ? ` · ${tool.description}` : ""}
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function MemorySection(props: SettingsPageProps) {
  const activeAgent = useMemo(
    () => props.agents.find((agent) => agent.id === props.selectedAgentId) ?? props.agents[0],
    [props.agents, props.selectedAgentId],
  );
  const [items, setItems] = useState<Memory[]>([]);
  const [status, setStatus] = useState<MemoryStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(agentId: string) {
    setError(null);
    try {
      const [nextStatus, nextItems] = await Promise.all([
        props.onGetMemoryStatus(agentId),
        props.onListMemories(agentId),
      ]);
      setStatus(nextStatus);
      setItems(nextItems);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  useEffect(() => {
    if (!activeAgent) {
      setItems([]);
      setStatus(null);
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

  async function reindex() {
    if (!activeAgent || busy) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await props.onReindexMemory(activeAgent.id));
      setItems(await props.onListMemories(activeAgent.id));
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

      {status ? (
        <div
          style={{
            border: "1px solid rgba(15, 15, 15, 0.08)",
            borderRadius: "var(--radius-md)",
            padding: 12,
            display: "grid",
            gap: 10,
            marginBottom: 16,
          }}
        >
          <div style={{ display: "grid", gap: 4 }}>
            <span style={{ color: "var(--text-tertiary)", fontSize: 12 }}>记忆根目录</span>
            <span style={{ color: "var(--text-primary)", fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
              {status.rootPath}
            </span>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <StatusPill label={`文件 ${status.fileCount}`} />
            <StatusPill label={`索引块 ${status.chunkCount}`} />
            <StatusPill label={`最近索引 ${status.indexedAt ? new Date(status.indexedAt).toLocaleString() : "-"}`} />
            <button
              type="button"
              className="btn-secondary"
              disabled={busy || !activeAgent}
              onClick={reindex}
              style={{ marginLeft: "auto" }}
            >
              重新索引
            </button>
          </div>
        </div>
      ) : null}

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

function parseArgs(raw: string): string[] {
  return raw
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return out;
}

function StatusPill({ label }: { label: string }) {
  return (
    <span
      style={{
        border: "1px solid var(--fill-tertiary)",
        borderRadius: "var(--radius-sm)",
        color: "var(--text-secondary)",
        fontSize: 12,
        padding: "4px 8px",
      }}
    >
      {label}
    </span>
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

function isToolEnabled(server: Partial<Pick<McpServer, "enabledTools" | "disabledTools">>, name: string): boolean {
  const disabledTools = getDisabledTools(server);
  const enabledTools = getEnabledTools(server);
  if (disabledTools.includes(name)) return false;
  if (enabledTools !== null && !enabledTools.includes(name)) return false;
  return true;
}

function getEnabledTools(server: Partial<Pick<McpServer, "enabledTools">>): string[] | null {
  return Array.isArray(server.enabledTools) ? server.enabledTools : null;
}

function getDisabledTools(server: Partial<Pick<McpServer, "disabledTools">>): string[] {
  return Array.isArray(server.disabledTools) ? server.disabledTools : [];
}

function isReadOnlyMcpTool(tool: Pick<McpToolSummary, "name" | "description">): boolean {
  const text = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
  if (/(write|delete|remove|move|rename|create|mkdir|rmdir|edit|patch|update|upload|save|set|insert|append|replace)/.test(text)) {
    return false;
  }
  return /(read|list|get|search|find|stat|info|tree|view|fetch|download|head|tail|inspect|describe)/.test(text);
}

function toggleName(items: string[], name: string, enabled: boolean): string[] {
  return enabled
    ? [...new Set([...items, name])]
    : items.filter((item) => item !== name);
}

function DotIcon() {
  return <span style={{ width: 6, height: 6, borderRadius: 999, background: "currentColor", opacity: 0.5 }} />;
}
