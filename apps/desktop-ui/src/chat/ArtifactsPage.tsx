import { useEffect, useMemo, useState } from "react";
import type { Agent } from "../api/agents";
import type {
  ArtifactEntryDto,
  ArtifactKind,
  ArtifactsListResponse,
} from "../api/artifacts";
import { Badge, ErrorAlert } from "./components";

export interface ArtifactsPageProps {
  agents: ReadonlyArray<Agent>;
  selectedAgentId: string;
  onListArtifacts: (query: { agentId?: string }) => Promise<ArtifactsListResponse>;
}

type KindFilter = "all" | ArtifactKind;

interface ListState {
  loading: boolean;
  items: ArtifactEntryDto[];
  error: string | null;
}

const KIND_OPTIONS: Array<{ value: KindFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "text", label: "文本" },
  { value: "file", label: "文件" },
  { value: "link", label: "链接" },
  { value: "data", label: "数据" },
];

export function ArtifactsPage(props: ArtifactsPageProps) {
  const [agentId, setAgentId] = useState<string>(props.selectedAgentId || "all");
  const [kind, setKind] = useState<KindFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [state, setState] = useState<ListState>({
    loading: false,
    items: [],
    error: null,
  });

  async function load() {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await props.onListArtifacts({
        agentId: agentId === "all" ? undefined : agentId,
      });
      setState({ loading: false, items: data.items, error: null });
      setSelectedId((current) => {
        if (current && data.items.some((item) => item.id === current)) return current;
        return data.items[0]?.id ?? null;
      });
    } catch (cause) {
      setState((prev) => ({
        ...prev,
        loading: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }));
    }
  }

  useEffect(() => {
    void load();
  }, [agentId]);

  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of props.agents) map.set(agent.id, agent.name);
    return map;
  }, [props.agents]);

  const filtered = useMemo(
    () => state.items.filter((item) => kind === "all" || item.kind === kind),
    [kind, state.items],
  );
  const selected =
    filtered.find((item) => item.id === selectedId) ?? filtered[0] ?? null;

  useEffect(() => {
    if (!selected && selectedId !== null) setSelectedId(null);
    else if (selected && selected.id !== selectedId) setSelectedId(selected.id);
  }, [selected?.id, selectedId]);

  return (
    <div className="page artifacts-page">
      <header className="page-header artifacts-page-header">
        <div className="artifacts-page-title">
          <h1>产物</h1>
          <p>运行生成的文本、文件、链接与结构化数据。</p>
        </div>
        <div className="artifacts-toolbar" role="toolbar" aria-label="产物筛选与刷新">
          <span className="artifacts-count" aria-live="polite">
            {state.loading ? "加载中…" : `${filtered.length} 个`}
          </span>
          <label>
            <span>智能体</span>
            <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              <option value="all">全部</option>
              {props.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>类型</span>
            <select value={kind} onChange={(event) => setKind(event.target.value as KindFilter)}>
              {KIND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="btn-secondary" disabled={state.loading} onClick={() => void load()}>
            {state.loading ? "刷新中…" : "刷新"}
          </button>
        </div>
      </header>

      <ErrorAlert message={state.error} />

      <div className="artifacts-layout">
        <section className="artifacts-list" aria-label="产物列表">
          {filtered.length === 0 && !state.loading ? (
            <div className="placeholder placeholder-tall">没有匹配的产物。</div>
          ) : (
            filtered.map((artifact) => (
              <button
                key={artifact.id}
                type="button"
                className={
                  "artifact-row" + (selected?.id === artifact.id ? " artifact-row-active" : "")
                }
                onClick={() => setSelectedId(artifact.id)}
              >
                <span className={`artifact-kind artifact-kind-${artifact.kind}`}>
                  {kindLabel(artifact.kind)}
                </span>
                <span className="artifact-row-main">
                  <strong>{artifact.title}</strong>
                  <span>
                    {agentNameById.get(artifact.agentId) ?? artifact.agentId} ·{" "}
                    {formatTime(artifact.createdAt)}
                  </span>
                </span>
                <span className="artifact-row-preview">{artifactPreview(artifact)}</span>
              </button>
            ))
          )}
        </section>

        <section className="artifact-detail" aria-label="产物详情">
          {selected ? (
            <ArtifactDetail artifact={selected} agentName={agentNameById.get(selected.agentId)} />
          ) : (
            <div className="placeholder placeholder-tall">选择一个产物查看内容。</div>
          )}
        </section>
      </div>
    </div>
  );
}

function ArtifactDetail({
  artifact,
  agentName,
}: {
  artifact: ArtifactEntryDto;
  agentName?: string;
}) {
  return (
    <div className="artifact-detail-inner">
      <div className="artifact-detail-head">
        <div>
          <Badge tone={badgeTone(artifact.kind)}>{kindLabel(artifact.kind)}</Badge>
          <h2>{artifact.title}</h2>
        </div>
        <span>{formatTime(artifact.createdAt)}</span>
      </div>

      <div className="artifact-meta-grid">
        <MetaItem label="智能体" value={agentName ?? artifact.agentId} />
        <MetaItem label="Run" value={shortId(artifact.runId)} monospace />
        <MetaItem label="会话" value={shortId(artifact.conversationId)} monospace />
        <MetaItem label="MIME" value={artifact.mimeType ?? "n/a"} />
      </div>

      {artifact.path ? (
        <div className="artifact-location">
          <span>路径</span>
          <code>{artifact.path}</code>
        </div>
      ) : null}

      {artifact.url ? (
        <div className="artifact-location">
          <span>链接</span>
          <a href={artifact.url} target="_blank" rel="noreferrer">
            {artifact.url}
          </a>
        </div>
      ) : null}

      <div className="artifact-preview-panel">
        {artifact.content ? (
          <pre>{previewContent(artifact)}</pre>
        ) : artifact.path || artifact.url ? (
          <p className="artifact-muted">该产物只记录了外部位置。</p>
        ) : (
          <p className="artifact-muted">没有可预览内容。</p>
        )}
      </div>

      {Object.keys(artifact.metadata).length > 0 ? (
        <details className="artifact-metadata">
          <summary>Metadata</summary>
          <pre>{formatJson(artifact.metadata)}</pre>
        </details>
      ) : null}
    </div>
  );
}

function MetaItem(props: { label: string; value: string; monospace?: boolean }) {
  return (
    <div>
      <span>{props.label}</span>
      {props.monospace ? <code>{props.value}</code> : <strong>{props.value}</strong>}
    </div>
  );
}

function artifactPreview(artifact: ArtifactEntryDto): string {
  if (artifact.content) return artifact.content.replace(/\s+/g, " ").slice(0, 120);
  if (artifact.path) return artifact.path;
  if (artifact.url) return artifact.url;
  return artifact.mimeType ?? "no preview";
}

function previewContent(artifact: ArtifactEntryDto): string {
  if (!artifact.content) return "";
  if (artifact.kind !== "data") return artifact.content;
  try {
    return JSON.stringify(JSON.parse(artifact.content), null, 2);
  } catch {
    return artifact.content;
  }
}

function kindLabel(kind: ArtifactKind): string {
  switch (kind) {
    case "text":
      return "文本";
    case "file":
      return "文件";
    case "link":
      return "链接";
    case "data":
      return "数据";
  }
}

function badgeTone(kind: ArtifactKind): "success" | "info" | "warning" | "danger" | "neutral" {
  switch (kind) {
    case "text":
      return "info";
    case "file":
      return "neutral";
    case "link":
      return "success";
    case "data":
      return "warning";
  }
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
