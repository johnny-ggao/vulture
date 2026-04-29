import { useEffect, useState } from "react";
import type {
  McpServer,
  McpToolSummary,
  McpTrust,
  UpdateMcpServer,
} from "../../api/mcpServers";
import {
  StatusPill,
  parseArgs,
  parseEnv,
  isToolEnabled,
  isReadOnlyMcpTool,
  getEnabledTools,
  getDisabledTools,
  toggleName,
} from "./shared";
import type { SettingsPageProps } from "./types";

export function McpSection(props: SettingsPageProps) {
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

      {error ? <div role="alert" style={{ color: "var(--danger)", marginBottom: 12 }}>{error}</div> : null}

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
                border: "1px solid var(--fill-tertiary)",
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
