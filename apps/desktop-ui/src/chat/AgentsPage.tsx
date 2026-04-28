import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { Agent, ReasoningLevel } from "../api/agents";

export interface AgentsPageProps {
  agents: ReadonlyArray<Agent>;
  selectedAgentId: string;
  onCreate: () => void;
  onOpenChat: (id: string) => void;
  onSave: (id: string, patch: AgentConfigPatch) => Promise<void>;
}

export interface AgentConfigPatch {
  name: string;
  description: string;
  model: string;
  reasoning: ReasoningLevel;
  skills?: string[] | null;
  instructions: string;
}

interface Draft {
  name: string;
  description: string;
  model: string;
  reasoning: ReasoningLevel;
  skillsText: string;
  instructions: string;
}

export function AgentsPage(props: AgentsPageProps) {
  const [activeId, setActiveId] = useState(props.selectedAgentId || props.agents[0]?.id || "");
  const active = useMemo(
    () => props.agents.find((agent) => agent.id === activeId) ?? props.agents[0],
    [activeId, props.agents],
  );
  const [draft, setDraft] = useState<Draft>(() => draftFromAgent(active));
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!active && props.agents[0]) setActiveId(props.agents[0].id);
  }, [active, props.agents]);

  useEffect(() => {
    setDraft(draftFromAgent(active));
  }, [active]);

  async function save() {
    if (!active || !draft.name.trim() || !draft.instructions.trim() || saving) return;
    setSaving(true);
    try {
      await props.onSave(active.id, {
        name: draft.name.trim(),
        description: draft.description.trim(),
        model: draft.model.trim(),
        reasoning: draft.reasoning,
        skills: parseSkills(draft.skillsText),
        instructions: draft.instructions.trim(),
      });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>智能体</h1>
          <p>每个智能体拥有独立 workspace、工具权限与能力包配置。</p>
        </div>
        <button type="button" className="btn-primary" onClick={props.onCreate}>
          新建智能体
        </button>
      </header>

      <div style={{ display: "grid", gridTemplateColumns: "280px minmax(0, 1fr)", gap: 16 }}>
        <div className="page-card" style={{ padding: 8, display: "grid", gap: 6, alignContent: "start" }}>
          {props.agents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => setActiveId(agent.id)}
              aria-pressed={agent.id === active?.id}
              style={{
                textAlign: "left",
                padding: "10px 12px",
                borderRadius: "var(--radius-md)",
                border: agent.id === active?.id ? "1px solid var(--brand-500)" : "1px solid transparent",
                background: agent.id === active?.id ? "var(--brand-050)" : "transparent",
                color: "var(--text-primary)",
                cursor: "pointer",
                display: "grid",
                gap: 4,
              }}
            >
              <span style={{ fontWeight: 650 }}>{agent.name}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>
                {agent.model}
              </span>
            </button>
          ))}
        </div>

        {active ? (
          <section className="page-card" style={{ padding: 18, display: "grid", gap: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
              <div>
                <h2 style={{ margin: 0, fontSize: 18 }}>Agent 配置</h2>
                <div style={{ marginTop: 4, fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>
                  {active.id}
                </div>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="btn-secondary" onClick={() => props.onOpenChat(active.id)}>
                  打开对话
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  disabled={saving || !draft.name.trim() || !draft.instructions.trim()}
                  onClick={save}
                >
                  {saving ? "保存中..." : "保存"}
                </button>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="名称">
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </Field>
              <Field label="模型">
                <input value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
              </Field>
              <Field label="推理强度">
                <select
                  value={draft.reasoning}
                  onChange={(e) => setDraft({ ...draft, reasoning: e.target.value as ReasoningLevel })}
                >
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </Field>
              <Field label="Skills">
                <input
                  aria-label="Skills"
                  value={draft.skillsText}
                  onChange={(e) => setDraft({ ...draft, skillsText: e.target.value })}
                  placeholder="留空=全部可用，逗号分隔；输入 none 禁用"
                />
              </Field>
            </div>

            <Field label="描述">
              <textarea
                rows={3}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </Field>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <InfoBlock title="Workspace" value={active.workspace.path} />
              <InfoBlock title="Tools" value={active.tools.join(", ") || "none"} />
            </div>

            <Field label="Instructions">
              <textarea
                rows={8}
                value={draft.instructions}
                onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
              />
            </Field>
          </section>
        ) : (
          <section className="page-card" style={{ padding: 18 }}>
            还没有智能体。
          </section>
        )}
      </div>
    </div>
  );
}

function draftFromAgent(agent: Agent | undefined): Draft {
  return {
    name: agent?.name ?? "",
    description: agent?.description ?? "",
    model: agent?.model ?? "",
    reasoning: agent?.reasoning ?? "medium",
    skillsText: agent?.skills === undefined ? "" : agent.skills.length === 0 ? "none" : agent.skills.join(", "),
    instructions: agent?.instructions ?? "",
  };
}

function parseSkills(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === "none") return [];
  return trimmed
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function Field(props: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6, color: "var(--text-secondary)", fontSize: 12 }}>
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

function InfoBlock(props: { title: string; value: string }) {
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ color: "var(--text-secondary)", fontSize: 12 }}>{props.title}</div>
      <div
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 1.5,
          color: "var(--text-primary)",
          background: "var(--fill-quaternary)",
          borderRadius: "var(--radius-sm)",
          padding: "8px 10px",
          overflowWrap: "anywhere",
        }}
      >
        {props.value}
      </div>
    </div>
  );
}
