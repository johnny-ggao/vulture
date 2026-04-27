import { useState } from "react";

const TEMPLATES = [
  { key: "blank",   label: "空白",     desc: "从零开始构建", instructions: "" },
  { key: "writer",  label: "写作助手", desc: "适合长文写作 + 编辑润色", instructions: "你是一名细致的中文写作助手。" },
  { key: "reviewer", label: "代码审阅", desc: "审 PR、读代码、定位 bug", instructions: "你是一名严谨的代码审阅者。" },
  { key: "shell",   label: "终端工具", desc: "运行 shell 命令的本地助手", instructions: "你是一名本地工作助手，可以使用 shell.exec 工具。" },
] as const;

export interface NewAgentModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (input: { name: string; description: string; instructions: string }) => Promise<void>;
}

export function NewAgentModal(props: NewAgentModalProps) {
  const [tplKey, setTplKey] = useState<typeof TEMPLATES[number]["key"]>("blank");
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [busy, setBusy] = useState(false);

  if (!props.open) return null;

  const tpl = TEMPLATES.find((t) => t.key === tplKey)!;

  async function submit() {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    setBusy(true);
    try {
      await props.onCreate({
        name: trimmedName,
        description: desc.trim() || tpl.desc,
        instructions: tpl.instructions,
      });
      setName("");
      setDesc("");
      setTplKey("blank");
      props.onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={props.onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <span className="modal-title">新建智能体</span>
          <button type="button" className="icon-btn" onClick={props.onClose} aria-label="关闭">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4l8 8M4 12l8-8" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <h4 style={{ fontSize: 12, color: "var(--text-tertiary)", textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>选择模板</h4>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
            {TEMPLATES.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTplKey(t.key)}
                style={{
                  textAlign: "left",
                  padding: "10px 12px",
                  borderRadius: "var(--radius-md)",
                  border: tplKey === t.key ? "1px solid var(--brand-500)" : "1px solid var(--fill-tertiary)",
                  background: tplKey === t.key ? "var(--brand-050)" : "var(--bg-primary)",
                  color: "var(--text-primary)",
                  cursor: "pointer",
                  minHeight: 0,
                  display: "grid",
                  gap: 4,
                }}
              >
                <span style={{ fontWeight: 600, fontSize: 13 }}>{t.label}</span>
                <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{t.desc}</span>
              </button>
            ))}
          </div>
          <label style={{ display: "grid", gap: 4, marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>名称</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例：周报助手"
              style={{
                padding: "8px 10px",
                border: "1px solid var(--fill-tertiary)",
                borderRadius: "var(--radius-sm)",
                background: "var(--bg-primary)",
                fontSize: 14,
              }}
            />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>描述（可选）</span>
            <textarea
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder={tpl.desc}
              rows={3}
              style={{
                padding: "8px 10px",
                border: "1px solid var(--fill-tertiary)",
                borderRadius: "var(--radius-sm)",
                background: "var(--bg-primary)",
                fontSize: 14,
                fontFamily: "inherit",
                resize: "vertical",
              }}
            />
          </label>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={props.onClose}>取消</button>
          <button
            type="button"
            className="btn-primary"
            onClick={submit}
            disabled={busy || !name.trim()}
            style={{ opacity: !name.trim() || busy ? 0.5 : 1 }}
          >
            {busy ? "创建中…" : "创建"}
          </button>
        </div>
      </div>
    </div>
  );
}
