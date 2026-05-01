import type { Agent } from "../../api/agents";
import { AgentAvatar } from "../components";
import type { Draft } from "./draft";

export interface HandoffTabProps {
  draft: Draft;
  agentId: string;
  agents: ReadonlyArray<Agent>;
  onChange: (next: Draft) => void;
}

/**
 * 协作 tab — handoff sub-agents the main agent may suggest enabling.
 *
 * Round 18: extracted from ToolsTab so handoff config is a first-class
 * concept rather than a footnote on the tool picker. The selection
 * surface is unchanged — checkbox row per candidate agent with avatar +
 * name + description — but it now lives on its own tab and gets a hero
 * description that explains the model's role in suggesting handoffs.
 */
export function HandoffTab({ draft, agentId, agents, onChange }: HandoffTabProps) {
  const handoffCandidates = agents.filter((agent) => agent.id !== agentId);

  return (
    <div className="agent-config-panel" role="tabpanel">
      <section className="agent-handoff-config">
        <div className="agent-handoff-head">
          <h3>可用子智能体</h3>
          <p>
            主智能体会自主判断是否建议开启子智能体；用户确认后才会创建。
            未在此处勾选的智能体不会被建议。
          </p>
        </div>
        {handoffCandidates.length === 0 ? (
          <div className="tool-group-empty">没有其他智能体可选</div>
        ) : (
          <div className="agent-handoff-list">
            {handoffCandidates.map((agent) => {
              const checked = draft.handoffAgentIds.includes(agent.id);
              return (
                <label
                  className={
                    "agent-handoff-row" +
                    (checked ? " agent-handoff-row-checked" : "")
                  }
                  key={agent.id}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    aria-label={`允许建议开启 ${agent.name}`}
                    onChange={(event) => {
                      const next = event.target.checked
                        ? [...draft.handoffAgentIds, agent.id]
                        : draft.handoffAgentIds.filter((id) => id !== agent.id);
                      onChange({
                        ...draft,
                        handoffAgentIds: [...new Set(next)],
                      });
                    }}
                  />
                  <span className="agent-handoff-avatar" aria-hidden="true">
                    <AgentAvatar agent={agent} size={28} shape="square" />
                  </span>
                  <span className="agent-handoff-meta">
                    <strong>{agent.name || agent.id}</strong>
                    <small>{agent.description || agent.id}</small>
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
