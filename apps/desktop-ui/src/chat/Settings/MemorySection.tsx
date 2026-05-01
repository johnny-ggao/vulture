import { useEffect, useMemo, useState } from "react";
import type { Memory, MemoryStatus } from "../../api/memories";
import { ErrorAlert, Field, SectionCard } from "../components";
import { StatusPill } from "./shared";
import { SettingsSection } from "./SettingsSection";
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(agentId: string) {
    setError(null);
    setLoading(true);
    try {
      const [nextStatus, nextItems] = await Promise.all([
        props.onGetMemoryStatus(agentId),
        props.onListMemories(agentId),
      ]);
      setStatus(nextStatus);
      setItems(nextItems);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!activeAgent) {
      setItems([]);
      setStatus(null);
      setLoading(false);
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
    <SettingsSection
      title="记忆"
      description="Markdown 文件是长期记忆源，索引用于检索与工具读取。"
      action={
        <Field label="智能体">
          <select
            aria-label="记忆智能体"
            value={activeAgent?.id ?? ""}
            onChange={(event) => props.onSelectAgent(event.target.value)}
          >
            {props.agents.map((agent) => (
              <option key={agent.id} value={agent.id}>{agent.name}</option>
            ))}
          </select>
        </Field>
      }
    >
      {status ? (
        <SectionCard className="memory-status">
          <Field label="记忆根目录">
            <span className="mono-readonly">{status.rootPath}</span>
          </Field>
          <div className="memory-status-row">
            <StatusPill label={`文件 ${status.fileCount}`} />
            <StatusPill label={`索引块 ${status.chunkCount}`} />
            <StatusPill label={`最近索引 ${status.indexedAt ? new Date(status.indexedAt).toLocaleString() : "-"}`} />
            <button
              type="button"
              className="btn-secondary memory-status-action"
              disabled={busy || !activeAgent}
              onClick={reindex}
            >
              重新索引
            </button>
          </div>
        </SectionCard>
      ) : null}

      <div className="memory-create">
        <textarea
          aria-label="新增记忆"
          rows={3}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="例如：用户喜欢简洁中文回答"
        />
        <div className="memory-create-actions">
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

      <ErrorAlert message={error} />

      {loading && items.length === 0 ? (
        <div className="memory-list" aria-busy="true" aria-label="加载记忆中">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="memory-skeleton" aria-hidden="true">
              <div className="memory-skeleton-line memory-skeleton-line-wide" />
              <div className="memory-skeleton-line memory-skeleton-line-mid" />
              <div className="memory-skeleton-foot" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="settings-empty">
          <p className="settings-empty-title">还没有记忆</p>
          <p className="settings-empty-sub">
            在上方文本框写下要让 <b>{activeAgent?.name ?? "当前智能体"}</b> 长期记住的事实，回车或点击「添加记忆」即可入库。
          </p>
        </div>
      ) : (
        <div className="memory-list">
          {items.map((memory) => (
            <SectionCard key={memory.id}>
              <div className="memory-content">{memory.content}</div>
              <div className="memory-meta">
                <span className="memory-meta-text">
                  {memory.path ? `${memory.path}${memory.heading ? ` # ${memory.heading}` : ""}` : new Date(memory.updatedAt).toLocaleString()}
                </span>
                <button
                  type="button"
                  className="btn-secondary btn-danger-ghost"
                  disabled={busy}
                  onClick={() => remove(memory)}
                >
                  删除
                </button>
              </div>
            </SectionCard>
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
