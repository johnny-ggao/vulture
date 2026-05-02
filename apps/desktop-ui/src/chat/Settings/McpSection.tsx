import { useEffect, useState } from "react";
import type {
  McpServer,
  McpToolSummary,
  McpTrust,
  UpdateMcpServer,
} from "../../api/mcpServers";
import {
  parseArgs,
  parseEnv,
  isToolEnabled,
  isReadOnlyMcpTool,
  getEnabledTools,
  getDisabledTools,
  toggleName,
} from "./shared";
import { Badge, ErrorAlert, Field } from "../components";
import { SectionGroup } from "./GeneralSection";
import { SettingsSection } from "./SettingsSection";
import type { SettingsPageProps } from "./types";

export function McpSection(props: SettingsPageProps) {
  const [items, setItems] = useState<McpServer[]>([]);
  const [toolsByServer, setToolsByServer] = useState<Record<string, McpToolSummary[]>>({});
  const [expandedToolsId, setExpandedToolsId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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
    setLoading(true);
    try {
      setItems(await props.onListMcpServers());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
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
    // Toggle: if this card is already expanded, collapse it.
    // Otherwise expand and (re-)fetch the tools list.
    if (expandedToolsId === server.id) {
      setExpandedToolsId(null);
      return;
    }
    setBusy(server.id);
    setError(null);
    try {
      const tools = await props.onListMcpServerTools(server.id);
      setToolsByServer((prev) => ({ ...prev, [server.id]: tools }));
      setExpandedToolsId(server.id);
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
    <SettingsSection
      title="MCP 服务器"
      description="本地 stdio MCP server 会作为 agent 工具加载，默认需要审批。"
      action={
        <button type="button" className="btn-secondary" disabled={busy !== null} onClick={load}>
          {busy === null ? "刷新" : "刷新中…"}
        </button>
      }
    >
      <ErrorAlert message={error} />

      {loading && items.length === 0 ? (
        <div className="mcp-card-grid" aria-busy="true" aria-label="加载 MCP 服务器中">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="mcp-card-skeleton" aria-hidden="true">
              <div className="mcp-card-skeleton-line mcp-card-skeleton-line-wide" />
              <div className="mcp-card-skeleton-line mcp-card-skeleton-line-mid" />
              <div className="mcp-card-skeleton-foot" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="settings-empty">
          <p className="settings-empty-title">还没有 MCP 服务器</p>
          <p className="settings-empty-sub">
            填写下方表单添加一个本地 stdio server，它会作为可调用的工具广播给所有智能体。
          </p>
        </div>
      ) : (
        <ul className="mcp-card-grid" aria-label="MCP 服务器">
          {items.map((server) => {
            const expanded = expandedToolsId === server.id;
            const tools = toolsByServer[server.id] ?? [];
            const isLocallyBusy = busy === server.id;
            return (
              <li
                key={server.id}
                className={
                  "mcp-card" +
                  (server.enabled ? "" : " mcp-card-off") +
                  (expanded ? " mcp-card-expanded" : "")
                }
              >
                <header className="mcp-card-head">
                  <div className="mcp-card-titles">
                    <h4 className="mcp-card-name">{server.name}</h4>
                    <p className="mcp-card-id">
                      <code>{server.id}</code>
                    </p>
                  </div>
                  <Badge tone={runtimeTone(server.runtime.status)}>
                    {runtimeLabel(server.runtime.status)} · {server.runtime.toolCount} 工具
                  </Badge>
                </header>

                <p className="mcp-card-cmd" title={`${server.command} ${server.args.join(" ")}`}>
                  <code>
                    {server.command} {server.args.join(" ")}
                  </code>
                </p>

                {server.runtime.lastError ? (
                  <div className="settings-feedback settings-feedback-error" role="alert">
                    {server.runtime.lastError}
                  </div>
                ) : null}

                <div className="mcp-card-foot">
                  <label className="mcp-checkbox-label">
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
                    className="mcp-trust-select"
                    value={server.trust}
                    disabled={busy !== null}
                    onChange={(e) => update(server, { trust: e.target.value as McpTrust })}
                  >
                    <option value="ask">ask</option>
                    <option value="trusted">trusted</option>
                    <option value="disabled">disabled</option>
                  </select>
                  <span className="mcp-card-foot-spacer" />
                  <button
                    type="button"
                    className="btn-secondary btn-sm"
                    disabled={busy !== null}
                    onClick={() => reconnect(server)}
                  >
                    {isLocallyBusy && !expanded ? "处理中…" : "重连"}
                  </button>
                  <button
                    type="button"
                    className={"btn-secondary btn-sm" + (expanded ? " mcp-tools-btn-active" : "")}
                    aria-expanded={expanded}
                    disabled={busy !== null && !isLocallyBusy}
                    onClick={() => loadTools(server)}
                  >
                    {expanded ? "收起" : "工具"}
                    <ChevronGlyph open={expanded} />
                  </button>
                  <button
                    type="button"
                    className="btn-secondary btn-sm btn-danger-ghost"
                    disabled={busy !== null}
                    onClick={() => remove(server)}
                  >
                    删除
                  </button>
                </div>

                {expanded ? (
                  <div className="mcp-card-tools">
                    <div className="mcp-tool-presets">
                      {(["all", "readonly", "none"] as const).map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          className="btn-secondary btn-sm"
                          disabled={busy !== null}
                          onClick={() => {
                            setBusy(server.id);
                            setError(null);
                            applyToolPreset(server, tools, preset)
                              .catch((cause) =>
                                setError(cause instanceof Error ? cause.message : String(cause)),
                              )
                              .finally(() => setBusy(null));
                          }}
                        >
                          {presetLabel(preset)}
                        </button>
                      ))}
                    </div>
                    {tools.length === 0 ? (
                      <p className="mcp-tool-empty">该服务器没有暴露任何工具。</p>
                    ) : (
                      <ul className="mcp-tool-list">
                        {tools.map((tool) => (
                          <li key={tool.name}>
                            <label className="mcp-tool-row">
                              <input
                                type="checkbox"
                                checked={tool.enabled ?? isToolEnabled(server, tool.name)}
                                disabled={busy !== null}
                                onChange={(e) => {
                                  setBusy(server.id);
                                  setError(null);
                                  toggleTool(server, tool, e.target.checked)
                                    .catch((cause) =>
                                      setError(
                                        cause instanceof Error ? cause.message : String(cause),
                                      ),
                                    )
                                    .finally(() => setBusy(null));
                                }}
                              />
                              <span className="mcp-tool-text">
                                <code className="mcp-tool-name">{tool.name}</code>
                                {tool.description ? (
                                  <span className="mcp-tool-desc">{tool.description}</span>
                                ) : null}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <SectionGroup title="添加服务器" hint="本地 stdio 进程；启动后默认 ask 信任。">
        <div className="mcp-create">
          <div className="mcp-create-grid">
            <Field label="ID" required>
              <input
                aria-label="MCP ID"
                value={draft.id}
                placeholder="echo-server"
                onChange={(e) => setDraft((v) => ({ ...v, id: e.target.value }))}
              />
            </Field>
            <Field label="名称" required>
              <input
                aria-label="MCP 名称"
                value={draft.name}
                placeholder="Echo"
                onChange={(e) => setDraft((v) => ({ ...v, name: e.target.value }))}
              />
            </Field>
          </div>
          <Field label="命令" required>
            <input
              aria-label="MCP 命令"
              value={draft.command}
              placeholder="bun"
              onChange={(e) => setDraft((v) => ({ ...v, command: e.target.value }))}
            />
          </Field>
          <Field label="参数" hint="空格分隔">
            <input
              aria-label="MCP 参数"
              value={draft.args}
              placeholder="run server.ts"
              onChange={(e) => setDraft((v) => ({ ...v, args: e.target.value }))}
            />
          </Field>
          <Field label="工作目录" hint="可选，绝对路径">
            <input
              aria-label="MCP 工作目录"
              value={draft.cwd}
              placeholder="/absolute/path"
              onChange={(e) => setDraft((v) => ({ ...v, cwd: e.target.value }))}
            />
          </Field>
          <Field label="环境变量" hint="每行一对 KEY=VALUE">
            <textarea
              aria-label="MCP 环境变量"
              rows={3}
              value={draft.env}
              placeholder={"KEY=value\nANOTHER=value"}
              onChange={(e) => setDraft((v) => ({ ...v, env: e.target.value }))}
            />
          </Field>
          <div className="mcp-create-actions">
            <label className="mcp-checkbox-label">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => setDraft((v) => ({ ...v, enabled: e.target.checked }))}
              />
              启用
            </label>
            <select
              aria-label="MCP 信任级别"
              value={draft.trust}
              onChange={(e) => setDraft((v) => ({ ...v, trust: e.target.value as McpTrust }))}
            >
              <option value="ask">ask</option>
              <option value="trusted">trusted</option>
              <option value="disabled">disabled</option>
            </select>
            <button
              type="button"
              className="btn-primary"
              disabled={busy !== null || !canCreate}
              onClick={create}
            >
              {busy === "create" ? "添加中..." : "添加服务器"}
            </button>
          </div>
        </div>
      </SectionGroup>
    </SettingsSection>
  );
}

function ChevronGlyph({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        marginLeft: 4,
        transition: "transform 160ms var(--ease-out)",
        transform: open ? "rotate(180deg)" : "rotate(0)",
      }}
    >
      <path d="M2.5 4l2.5 2.5L7.5 4" />
    </svg>
  );
}

function runtimeLabel(status: McpServer["runtime"]["status"]): string {
  switch (status) {
    case "connected":    return "已连接";
    case "disconnected": return "未连接";
    case "failed":       return "失败";
  }
}

function presetLabel(preset: "all" | "readonly" | "none"): string {
  switch (preset) {
    case "all": return "全部开启";
    case "readonly": return "只读";
    case "none": return "全部关闭";
  }
}

function runtimeTone(
  status: McpServer["runtime"]["status"],
): "success" | "info" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "connected":    return "success";
    case "disconnected": return "warning";
    case "failed":       return "danger";
    default:             return "neutral";
  }
}
