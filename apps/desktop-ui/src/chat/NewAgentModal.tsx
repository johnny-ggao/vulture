import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { AgentToolName, AgentToolPreset, ReasoningLevel } from "../api/agents";
import type { ToolCatalogGroup, ToolPolicyDraft } from "../api/tools";
import { toolPolicyFromPreset, toolPolicyFromSelection } from "../api/tools";
import { ToolGroupSelector } from "./ToolGroupSelector";

const TEMPLATES = [
  { key: "blank", label: "空白", desc: "从零开始构建", instructions: "" },
  { key: "writer", label: "写作助手", desc: "适合长文写作 + 编辑润色", instructions: "你是一名细致的中文写作助手。" },
  { key: "reviewer", label: "代码审阅", desc: "审 PR、读代码、定位 bug", instructions: "你是一名严谨的代码审阅者。" },
  { key: "shell", label: "本地工具", desc: "读写文件、运行命令、检索网页", instructions: "你是一名本地工作助手，可以使用文件、终端、网页和会话工具。" },
] as const;

type TemplateKey = typeof TEMPLATES[number]["key"];
type WizardStep = "template" | "identity" | "tools" | "skills" | "persona";

const STEPS: Array<{ id: WizardStep; label: string; desc: string }> = [
  { id: "template", label: "模板", desc: "选择起点" },
  { id: "identity", label: "身份与模型", desc: "名称、模型、描述" },
  { id: "tools", label: "工具能力", desc: "预设与类目" },
  { id: "skills", label: "Skills", desc: "能力包策略" },
  { id: "persona", label: "Persona", desc: "行为边界" },
];

export interface NewAgentInput {
  name: string;
  description: string;
  instructions: string;
  model: string;
  reasoning: ReasoningLevel;
  tools: AgentToolName[];
  toolPreset: AgentToolPreset;
  toolInclude: AgentToolName[];
  toolExclude: AgentToolName[];
  skills?: string[] | null;
}

export interface NewAgentModalProps {
  open: boolean;
  toolGroups: ReadonlyArray<ToolCatalogGroup>;
  onClose: () => void;
  onCreate: (input: NewAgentInput) => Promise<void>;
}

export function NewAgentModal(props: NewAgentModalProps) {
  const [step, setStep] = useState<WizardStep>("template");
  const [tplKey, setTplKey] = useState<TemplateKey>("blank");
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [model, setModel] = useState("gpt-5.5");
  const [reasoning, setReasoning] = useState<ReasoningLevel>("low");
  const [toolPolicy, setToolPolicy] = useState<ToolPolicyDraft>(() => toolPolicyFromPreset("developer"));
  const [skillsText, setSkillsText] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);

  const tpl = TEMPLATES.find((t) => t.key === tplKey)!;
  const stepIndex = STEPS.findIndex((item) => item.id === step);
  const canGoNext = step !== "identity" || name.trim().length > 0;
  const previewInstructions = instructions.trim() || tpl.instructions || (name.trim() ? `你是 ${name.trim()}。` : "");
  const selectedToolCount = toolPolicy.tools.length;
  const skillsSummary = useMemo(() => {
    const parsed = parseSkills(skillsText);
    if (parsed === null) return "全部可用";
    if (parsed.length === 0) return "已禁用";
    return `${parsed.length} 个 allowlist`;
  }, [skillsText]);

  if (!props.open) return null;

  function reset() {
    setStep("template");
    setName("");
    setDesc("");
    setTplKey("blank");
    setModel("gpt-5.5");
    setReasoning("low");
    setToolPolicy(toolPolicyFromPreset("developer"));
    setSkillsText("");
    setInstructions("");
  }

  function close() {
    if (busy) return;
    reset();
    props.onClose();
  }

  function goNext() {
    if (!canGoNext) return;
    const next = STEPS[stepIndex + 1];
    if (next) setStep(next.id);
  }

  function goBack() {
    const prev = STEPS[stepIndex - 1];
    if (prev) setStep(prev.id);
  }

  async function submit() {
    const trimmedName = name.trim();
    if (!trimmedName || busy) return;
    setBusy(true);
    try {
      await props.onCreate({
        name: trimmedName,
        description: desc.trim() || tpl.desc,
        instructions: previewInstructions,
        model: model.trim() || "gpt-5.5",
        reasoning,
        tools: toolPolicy.tools,
        toolPreset: toolPolicy.toolPreset,
        toolInclude: toolPolicy.toolInclude,
        toolExclude: toolPolicy.toolExclude,
        skills: parseSkills(skillsText),
      });
      reset();
      props.onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 920, maxHeight: "86vh" }}>
        <div className="modal-header">
          <div>
            <span className="modal-title">新建智能体</span>
            <div style={{ marginTop: 4, color: "var(--text-tertiary)", fontSize: 12 }}>
              {STEPS[stepIndex]?.label} · {STEPS[stepIndex]?.desc}
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={close} aria-label="关闭">
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4l8 8M4 12l8-8" /></svg>
          </button>
        </div>

        <div className="modal-body" style={{ padding: 0 }}>
          <div style={{ display: "grid", gridTemplateColumns: "190px minmax(0, 1fr) 260px", minHeight: 520 }}>
            <aside style={{ borderRight: "1px solid var(--fill-quaternary)", padding: 16, display: "grid", gap: 8, alignContent: "start" }}>
              {STEPS.map((item, index) => {
                const active = item.id === step;
                const complete = index < stepIndex;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      if (item.id === "identity" || name.trim() || index <= stepIndex) setStep(item.id);
                    }}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "24px 1fr",
                      gap: 10,
                      alignItems: "start",
                      textAlign: "left",
                      padding: "9px 8px",
                      border: "0",
                      borderRadius: "var(--radius-md)",
                      background: active ? "var(--brand-050)" : "transparent",
                      color: active ? "var(--brand-600)" : "var(--text-secondary)",
                      cursor: "pointer",
                    }}
                  >
                    <span
                      style={{
                        width: 22,
                        height: 22,
                        display: "grid",
                        placeItems: "center",
                        borderRadius: "50%",
                        background: active || complete ? "var(--brand-500)" : "var(--fill-tertiary)",
                        color: active || complete ? "#fff" : "var(--text-secondary)",
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                      }}
                    >
                      {complete ? "✓" : index + 1}
                    </span>
                    <span style={{ display: "grid", gap: 2 }}>
                      <span style={{ fontWeight: 650, fontSize: 13 }}>{item.label}</span>
                      <span style={{ fontSize: 11, color: active ? "var(--brand-600)" : "var(--text-tertiary)" }}>{item.desc}</span>
                    </span>
                  </button>
                );
              })}
            </aside>

            <main style={{ padding: 20, overflow: "auto" }}>
              {step === "template" ? (
                <StepSection title="选择模板" subtitle="模板只决定初始文案，后续每一步都可以调整。">
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    {TEMPLATES.map((t) => (
                      <button
                        key={t.key}
                        type="button"
                        onClick={() => {
                          setTplKey(t.key);
                          setInstructions(t.instructions);
                          if (!desc.trim()) setDesc(t.desc);
                        }}
                        style={{
                          textAlign: "left",
                          padding: "14px 14px",
                          borderRadius: "var(--radius-md)",
                          border: tplKey === t.key ? "1px solid var(--brand-500)" : "1px solid var(--fill-tertiary)",
                          background: tplKey === t.key ? "var(--brand-050)" : "var(--bg-primary)",
                          color: "var(--text-primary)",
                          cursor: "pointer",
                          display: "grid",
                          gap: 5,
                        }}
                      >
                        <span style={{ fontWeight: 650 }}>{t.label}</span>
                        <span style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.45 }}>{t.desc}</span>
                      </button>
                    ))}
                  </div>
                </StepSection>
              ) : null}

              {step === "identity" ? (
                <StepSection title="身份与模型" subtitle="定义这个智能体在列表、对话和运行时使用的基础配置。">
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                    <Field label="名称">
                      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例：周报助手" />
                    </Field>
                    <Field label="模型">
                      <input value={model} onChange={(e) => setModel(e.target.value)} />
                    </Field>
                    <Field label="推理强度">
                      <select value={reasoning} onChange={(e) => setReasoning(e.target.value as ReasoningLevel)}>
                        <option value="low">low</option>
                        <option value="medium">medium</option>
                        <option value="high">high</option>
                      </select>
                    </Field>
                  </div>
                  <Field label="描述">
                    <textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder={tpl.desc} rows={4} />
                  </Field>
                </StepSection>
              ) : null}

              {step === "tools" ? (
                <StepSection title="工具能力" subtitle="先选预设，再按能力类目微调。底层工具会自动展开保存。">
                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, alignItems: "end" }}>
                    <Field label="工具预设">
                      <select
                        value={toolPolicy.toolPreset}
                        onChange={(event) => setToolPolicy(toolPolicyFromPreset(event.target.value as AgentToolPreset))}
                      >
                        <option value="minimal">minimal</option>
                        <option value="standard">standard</option>
                        <option value="developer">developer</option>
                        <option value="tl">tl</option>
                        <option value="full">full</option>
                        <option value="none">none</option>
                      </select>
                    </Field>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button type="button" className="btn-secondary" onClick={() => setToolPolicy(toolPolicyFromPreset("full"))}>
                        全选
                      </button>
                      <button type="button" className="btn-secondary" onClick={() => setToolPolicy(toolPolicyFromPreset("none"))}>
                        清空
                      </button>
                    </div>
                  </div>
                  <ToolGroupSelector
                    groups={props.toolGroups}
                    selected={toolPolicy.tools}
                    onChange={(tools) => setToolPolicy(toolPolicyFromSelection(toolPolicy.toolPreset, tools))}
                  />
                </StepSection>
              ) : null}

              {step === "skills" ? (
                <StepSection title="Skills" subtitle="留空表示可加载全部已启用 Skills；输入 none 表示禁用。">
                  <Field label="Skills">
                    <input
                      aria-label="Skills"
                      value={skillsText}
                      onChange={(e) => setSkillsText(e.target.value)}
                      placeholder="留空=全部可用，逗号分隔；输入 none 禁用"
                    />
                  </Field>
                </StepSection>
              ) : null}

              {step === "persona" ? (
                <StepSection title="Persona / Instructions" subtitle="写入智能体核心行为边界；创建后仍可在 Agent Core 中细调。">
                  <Field label="Instructions">
                    <textarea
                      value={instructions}
                      onChange={(e) => setInstructions(e.target.value)}
                      placeholder={tpl.instructions || "定义这个智能体的行为边界、工作方式和输出风格"}
                      rows={10}
                    />
                  </Field>
                </StepSection>
              ) : null}
            </main>

            <aside style={{ borderLeft: "1px solid var(--fill-quaternary)", background: "var(--fill-quaternary)", padding: 18 }}>
              <div style={{ display: "grid", gap: 12 }}>
                <div style={{ color: "var(--text-tertiary)", fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>
                  Live Preview
                </div>
                <div
                  style={{
                    background: "var(--bg-primary)",
                    border: "1px solid var(--fill-tertiary)",
                    borderRadius: "var(--radius-lg)",
                    overflow: "hidden",
                  }}
                >
                  <div style={{ height: 56, background: "var(--brand-050)", position: "relative" }}>
                    <div
                      style={{
                        position: "absolute",
                        left: "50%",
                        bottom: -22,
                        transform: "translateX(-50%)",
                        width: 54,
                        height: 54,
                        borderRadius: "var(--radius-md)",
                        display: "grid",
                        placeItems: "center",
                        background: "var(--brand-500)",
                        color: "#fff",
                        fontWeight: 700,
                        border: "4px solid var(--bg-primary)",
                      }}
                    >
                      {(name.trim() || tpl.label).slice(0, 1).toUpperCase()}
                    </div>
                  </div>
                  <div style={{ padding: "34px 16px 16px", textAlign: "center", display: "grid", gap: 10 }}>
                    <div style={{ fontWeight: 700, color: "var(--text-primary)" }}>{name.trim() || "新智能体"}</div>
                    <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.45 }}>
                      {desc.trim() || tpl.desc}
                    </div>
                    <div style={{ display: "grid", gap: 5, borderTop: "1px solid var(--fill-quaternary)", paddingTop: 12 }}>
                      <PreviewRow label="Model" value={model || "gpt-5.5"} />
                      <PreviewRow label="Tools" value={`${selectedToolCount}`} />
                      <PreviewRow label="Skills" value={skillsSummary} />
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 }}>
                  {previewInstructions || "选择模板并填写名称后，这里会显示最终创建时的行为摘要。"}
                </div>
              </div>
            </aside>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={stepIndex === 0 ? close : goBack}>
            {stepIndex === 0 ? "取消" : "上一步"}
          </button>
          {step === "persona" ? (
            <button
              type="button"
              className="btn-primary"
              onClick={submit}
              disabled={busy || !name.trim()}
              style={{ opacity: !name.trim() || busy ? 0.5 : 1 }}
            >
              {busy ? "创建中..." : "创建"}
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              onClick={goNext}
              disabled={!canGoNext}
              style={{ opacity: canGoNext ? 1 : 0.5 }}
            >
              继续
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StepSection(props: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 16 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>{props.title}</h2>
        <p style={{ margin: "6px 0 0", color: "var(--text-secondary)", fontSize: 13 }}>{props.subtitle}</p>
      </div>
      {props.children}
    </section>
  );
}

function Field(props: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 6, color: "var(--text-secondary)", fontSize: 12 }}>
      <span>{props.label}</span>
      {props.children}
    </label>
  );
}

function PreviewRow(props: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 11 }}>
      <span style={{ color: "var(--text-tertiary)" }}>{props.label}</span>
      <span style={{ color: "var(--text-primary)", fontFamily: "var(--font-mono)" }}>{props.value}</span>
    </div>
  );
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
