import { useEffect, useMemo, useState } from "react";
import type { Agent } from "../api/agents";
import type { SkillListItem, SkillListResponse } from "../api/skills";

export interface SkillsPageProps {
  agents: ReadonlyArray<Agent>;
  selectedAgentId: string;
  onSelectAgent: (id: string) => void;
  onLoadSkills: (agentId: string) => Promise<SkillListResponse>;
  onSaveAgentSkills: (id: string, skills: string[] | null) => Promise<void>;
}

type LoadState =
  | { status: "idle" | "loading"; data: SkillListResponse | null; error: string | null }
  | { status: "ready"; data: SkillListResponse; error: null }
  | { status: "error"; data: SkillListResponse | null; error: string };

export function SkillsPage(props: SkillsPageProps) {
  const [state, setState] = useState<LoadState>({ status: "idle", data: null, error: null });
  const [saving, setSaving] = useState(false);
  const activeAgent = useMemo(
    () => props.agents.find((agent) => agent.id === props.selectedAgentId) ?? props.agents[0],
    [props.agents, props.selectedAgentId],
  );

  async function load(agentId: string, cancelled: () => boolean = () => false) {
    setState((prev) => ({ status: "loading", data: prev.data, error: null }));
    try {
      const data = await props.onLoadSkills(agentId);
      if (!cancelled()) setState({ status: "ready", data, error: null });
    } catch (cause) {
      if (!cancelled()) {
        setState({
          status: "error",
          data: null,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }

  useEffect(() => {
    if (!activeAgent) return;
    let cancelled = false;
    void load(activeAgent.id, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [activeAgent?.id]);

  async function savePolicy(skills: string[] | null) {
    if (!activeAgent || saving) return;
    setSaving(true);
    try {
      await props.onSaveAgentSkills(activeAgent.id, skills);
      await load(activeAgent.id);
    } finally {
      setSaving(false);
    }
  }

  async function toggleSkill(skill: SkillListItem) {
    const data = state.data;
    if (!data) return;
    const current = new Set(
      data.policy === "all"
        ? data.items.map((item) => item.name)
        : data.allowlist ?? [],
    );
    if (current.has(skill.name)) current.delete(skill.name);
    else current.add(skill.name);
    await savePolicy([...current].sort((left, right) => left.localeCompare(right, "en")));
  }

  const data = state.data;
  const items = data?.items ?? [];

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>技能</h1>
          <p>按智能体配置可加载能力包，控制模型可见的 skill allowlist。</p>
        </div>
      </header>

      <section className="page-card" style={{ padding: 18, display: "grid", gap: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "end", flexWrap: "wrap" }}>
          <label style={{ display: "grid", gap: 6, minWidth: 260, color: "var(--text-secondary)", fontSize: 12 }}>
            <span>智能体</span>
            <select
              value={activeAgent?.id ?? ""}
              aria-label="选择智能体"
              onChange={(event) => props.onSelectAgent(event.target.value)}
            >
              {props.agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              className={data?.policy === "all" ? "btn-primary" : "btn-secondary"}
              disabled={!activeAgent || saving}
              onClick={() => savePolicy(null)}
            >
              全部启用
            </button>
            <button
              type="button"
              className={data?.policy === "none" ? "btn-primary" : "btn-secondary"}
              disabled={!activeAgent || saving}
              onClick={() => savePolicy([])}
            >
              全部禁用
            </button>
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", color: "var(--text-secondary)", fontSize: 13 }}>
          <span>策略：{policyLabel(data?.policy)}</span>
          <span>·</span>
          <span>{items.length} 个可加载 skill</span>
          {state.status === "loading" ? <span>刷新中...</span> : null}
          {saving ? <span>保存中...</span> : null}
        </div>

        {state.error ? (
          <div style={{ color: "var(--danger)", fontSize: 13 }}>{state.error}</div>
        ) : null}

        {items.length === 0 && state.status !== "loading" ? (
          <div className="placeholder" style={{ minHeight: 140 }}>
            <span>当前智能体没有可加载的 skill。</span>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {items.map((skill) => (
              <article
                key={skill.name}
                style={{
                  border: "1px solid rgba(15, 15, 15, 0.08)",
                  borderRadius: "var(--radius-md)",
                  padding: 14,
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  gap: 12,
                  alignItems: "start",
                }}
              >
                <div style={{ display: "grid", gap: 6, minWidth: 0 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <strong style={{ color: "var(--text-primary)" }}>{skill.name}</strong>
                    <Badge>{skill.source}</Badge>
                    <Badge>{skill.modelInvocationEnabled ? "模型可见" : "仅手动"}</Badge>
                    <Badge>{skill.enabled ? "已启用" : "已禁用"}</Badge>
                  </div>
                  <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>{skill.description}</div>
                  <code style={{ color: "var(--text-tertiary)", fontSize: 12, overflowWrap: "anywhere" }}>
                    {skill.filePath}
                  </code>
                </div>
                <button
                  type="button"
                  className={skill.enabled ? "btn-secondary" : "btn-primary"}
                  disabled={saving}
                  onClick={() => toggleSkill(skill)}
                >
                  {skill.enabled ? "禁用" : "启用"}
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function policyLabel(policy: SkillListResponse["policy"] | undefined): string {
  if (policy === "all") return "全部启用";
  if (policy === "none") return "全部禁用";
  if (policy === "allowlist") return "仅启用所选";
  return "加载中";
}

function Badge(props: { children: string }) {
  return (
    <span
      style={{
        border: "1px solid rgba(15, 15, 15, 0.08)",
        borderRadius: 999,
        padding: "2px 7px",
        color: "var(--text-secondary)",
        fontSize: 12,
        lineHeight: 1.3,
      }}
    >
      {props.children}
    </span>
  );
}
