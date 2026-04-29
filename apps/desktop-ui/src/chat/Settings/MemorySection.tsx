import { useEffect, useMemo, useState } from "react";
import type { Memory, MemoryStatus } from "../../api/memories";
import { StatusPill } from "./shared";
import type { SettingsPageProps } from "./types";

export function MemorySection(props: SettingsPageProps) {
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
            border: "1px solid var(--fill-tertiary)",
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

      {error ? <div role="alert" style={{ color: "var(--danger)", marginBottom: 12 }}>{error}</div> : null}

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
                border: "1px solid var(--fill-tertiary)",
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
