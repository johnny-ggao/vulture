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
import { Badge, ErrorAlert, Field, SectionCard } from "../components";
import { SettingsSection } from "./SettingsSection";
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
    <SettingsSection
      title="MCP 服务器"
      description="本地 stdio MCP server 会作为 agent 工具加载，默认需要审批。"
      action={
        <button type="button" className="btn-secondary" disabled={busy !== null} onClick={load}>
          {busy === null ? "刷新" : "刷新中…"}
        </button>
      }
    >
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

      <ErrorAlert message={error} />

      {items.length === 0 ? (
        <div className="placeholder placeholder-tall">
          <span>还没有 MCP 服务器。</span>
        </div>
      ) : (
        <div className="mcp-server-list">
          {items.map((server) => (
            <article key={server.id} className="mcp-server">
              <div className="mcp-server-head">
                <div className="mcp-server-meta">
                  <div className="mcp-server-name">{server.name}</div>
                  <div className="mcp-server-cmd">
                    {server.id} · {server.command} {server.args.join(" ")}
                  </div>
                </div>
                <Badge tone={runtimeTone(server.runtime.status)}>
                  {server.runtime.status} · tools {server.runtime.toolCount}
                </Badge>
              </div>
              {server.runtime.lastError ? (
                <div className="mcp-server-error">{server.runtime.lastError}</div>
              ) : null}
              <div className="mcp-server-controls">
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
                  value={server.trust}
                  disabled={busy !== null}
                  onChange={(e) => update(server, { trust: e.target.value as McpTrust })}
                >
                  <option value="ask">ask</option>
                  <option value="trusted">trusted</option>
                  <option value="disabled">disabled</option>
                </select>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy !== null}
                  onClick={() => reconnect(server)}
                >
                  {busy === server.id ? "处理中..." : "重连"}
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy !== null}
                  onClick={() => loadTools(server)}
                >
                  工具
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy !== null}
                  onClick={() => remove(server)}
                >
                  删除
                </button>
              </div>
              {toolsByServer[server.id]?.length ? (
                <div className="mcp-tool-list">
                  <div className="mcp-tool-presets">
                    {(["all", "readonly", "none"] as const).map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        className="btn-secondary"
                        disabled={busy !== null}
                        onClick={() => {
                          setBusy(server.id);
                          setError(null);
                          applyToolPreset(server, toolsByServer[server.id], preset)
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
                  {toolsByServer[server.id].map((tool) => (
                    <label key={tool.name} className="mcp-tool-row">
                      <input
                        type="checkbox"
                        checked={tool.enabled ?? isToolEnabled(server, tool.name)}
                        disabled={busy !== null}
                        onChange={(e) => {
                          setBusy(server.id);
                          setError(null);
                          toggleTool(server, tool, e.target.checked)
                            .catch((cause) =>
                              setError(cause instanceof Error ? cause.message : String(cause)),
                            )
                            .finally(() => setBusy(null));
                        }}
                      />
                      <span>
                        <code className="mcp-tool-name">{tool.name}</code>
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
    </SettingsSection>
  );
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
