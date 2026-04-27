import type { Agent } from "../api/agents";

export interface AgentsPageProps {
  agents: ReadonlyArray<Agent>;
  onCreate: () => void;
  onSelect: (id: string) => void;
}

export function AgentsPage(props: AgentsPageProps) {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>智能体</h1>
          <p>每个智能体拥有独立的 workspace 与工具权限。</p>
        </div>
      </header>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
          gap: 14,
        }}
      >
        <button
          type="button"
          className="page-card"
          onClick={props.onCreate}
          style={{
            display: "grid",
            placeItems: "center",
            border: "1px dashed var(--fill-secondary)",
            background: "transparent",
            color: "var(--text-tertiary)",
            cursor: "pointer",
            minHeight: 150,
            padding: 16,
          }}
        >
          <div style={{ fontSize: 22, lineHeight: 1 }}>+</div>
          <div style={{ marginTop: 6, fontSize: 13 }}>新建智能体</div>
        </button>
        {props.agents.map((a) => (
          <button
            key={a.id}
            type="button"
            className="page-card"
            onClick={() => props.onSelect(a.id)}
            style={{
              textAlign: "left",
              cursor: "pointer",
              border: "1px solid var(--fill-tertiary)",
              padding: "16px 18px",
              display: "grid",
              gap: 10,
              minHeight: 0,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  display: "grid",
                  placeItems: "center",
                  background: "var(--brand-050)",
                  color: "var(--brand-600)",
                  fontWeight: 700,
                  fontSize: 14,
                }}
              >
                {a.name.slice(0, 1)}
              </span>
              <div style={{ display: "grid" }}>
                <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{a.name}</span>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>{a.model}</span>
              </div>
            </div>
            <div style={{ fontSize: 13, color: "var(--text-secondary)", lineHeight: 1.5, minHeight: 40 }}>
              {a.description || "—"}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {(a.tools ?? []).slice(0, 4).map((t: string) => (
                <span
                  key={t}
                  style={{
                    fontSize: 11,
                    padding: "2px 8px",
                    borderRadius: 999,
                    background: "var(--fill-quaternary)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
