import type * as React from "react";
import { useMemo, useState } from "react";
import type { AgentToolName, AgentToolPreset, ReasoningLevel } from "../api/agents";
import type { ToolCatalogGroup, ToolPolicyDraft } from "../api/tools";
import { toolPolicyFromPreset, toolPolicyFromSelection } from "../api/tools";
import { ToolGroupSelector } from "./ToolGroupSelector";
import { AgentAvatar, Field, hashHue, useCursorGloss } from "./components";

type TemplateKey = "blank" | "writer" | "reviewer" | "shell";

interface Template {
  key: TemplateKey;
  label: string;
  desc: string;
  instructions: string;
  Icon: () => JSX.Element;
}

const TEMPLATES: ReadonlyArray<Template> = [
  { key: "blank",    label: "空白",       desc: "从零开始构建",                        instructions: "",                                                       Icon: BlankIcon },
  { key: "writer",   label: "写作助手",   desc: "适合长文写作 + 编辑润色",             instructions: "你是一名细致的中文写作助手。",                          Icon: WriterIcon },
  { key: "reviewer", label: "代码审阅",   desc: "审 PR、读代码、定位 bug",             instructions: "你是一名严谨的代码审阅者。",                            Icon: ReviewerIcon },
  { key: "shell",    label: "本地工具",   desc: "读写文件、运行命令、检索网页",        instructions: "你是一名本地工作助手，可以使用文件、终端、网页和会话工具。", Icon: ShellIcon },
];

// Step order matches Accio: Template → Identity → Persona → Tools → Skills.
// Persona slots before Tools because the agent's role determines which tools
// it actually needs.
type WizardStep = "template" | "identity" | "persona" | "tools" | "skills";

const STEPS: ReadonlyArray<{ id: WizardStep; label: string; desc: string }> = [
  { id: "template", label: "模板",     desc: "选择起点" },
  { id: "identity", label: "身份与模型", desc: "名称、模型、描述" },
  { id: "persona",  label: "Persona",   desc: "行为边界" },
  { id: "tools",    label: "工具能力",  desc: "预设与类目" },
  { id: "skills",   label: "Skills",    desc: "能力包策略" },
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

  // The avatar peeks at "the agent we're building", so it needs a stable id
  // even before submit. We hash on the entered name; falls back to the
  // template key while empty.
  const previewAgent = {
    id: name.trim() || tpl.key,
    name: name.trim() || "新智能体",
  };

  // Cursor-tracked gloss on the preview card — completes the visual rhyme:
  // the user hovers the live preview and gets the same Apple-product-card
  // spotlight they'll see on the real AgentCard once the agent is created.
  // Must be called before the early-return so the hook order stays stable
  // across open/closed renders.
  const { ref: previewRef, ...previewGloss } = useCursorGloss<HTMLDivElement>();

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

  const progressPercent = Math.round(((stepIndex + 1) / STEPS.length) * 100);

  return (
    <div className="modal-overlay" onClick={close}>
      <div className="modal-card new-agent-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="new-agent-header-meta">
            <span className="modal-title">新建智能体</span>
            <div className="new-agent-step-meta">
              <span>步骤 {stepIndex + 1} / {STEPS.length}</span>
              <span aria-hidden="true">·</span>
              <span>{STEPS[stepIndex]?.label}</span>
              <span className="new-agent-step-desc">{STEPS[stepIndex]?.desc}</span>
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={close} aria-label="关闭" disabled={busy}>
            <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"><path d="M4 4l8 8M4 12l8-8" /></svg>
          </button>
        </div>
        <div
          className="new-agent-progress"
          role="progressbar"
          aria-valuenow={stepIndex + 1}
          aria-valuemin={1}
          aria-valuemax={STEPS.length}
          aria-label="创建进度"
        >
          <div
            className="new-agent-progress-bar"
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        <div className="modal-body new-agent-body">
          <div className="new-agent-grid">
            <aside className="new-agent-rail" aria-label="创建步骤">
              {STEPS.map((item, index) => {
                const active = item.id === step;
                const complete = index < stepIndex;
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={"new-agent-rail-item" + (active ? " active" : "") + (complete ? " complete" : "")}
                    onClick={() => {
                      if (item.id === "template" || item.id === "identity" || name.trim() || index <= stepIndex) {
                        setStep(item.id);
                      }
                    }}
                  >
                    <span className="new-agent-rail-bullet">
                      {complete ? <CheckSmall /> : index + 1}
                    </span>
                    <span className="new-agent-rail-text">
                      <span className="new-agent-rail-label">{item.label}</span>
                      <span className="new-agent-rail-desc">{item.desc}</span>
                    </span>
                  </button>
                );
              })}
            </aside>

            <main className="new-agent-main">
              {step === "template" ? (
                <StepSection title="选择模板" subtitle="模板只决定初始文案，后续每一步都可以调整。">
                  <div className="new-agent-templates">
                    {TEMPLATES.map((t) => {
                      const TemplateIcon = t.Icon;
                      const selected = tplKey === t.key;
                      return (
                        <button
                          key={t.key}
                          type="button"
                          className={"new-agent-template" + (selected ? " selected" : "")}
                          onClick={() => {
                            setTplKey(t.key);
                            setInstructions(t.instructions);
                            if (!desc.trim()) setDesc(t.desc);
                          }}
                        >
                          <span className="new-agent-template-icon" aria-hidden="true">
                            <TemplateIcon />
                          </span>
                          <span className="new-agent-template-meta">
                            <span className="new-agent-template-label">{t.label}</span>
                            <span className="new-agent-template-desc">{t.desc}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </StepSection>
              ) : null}

              {step === "identity" ? (
                <StepSection title="身份与模型" subtitle="定义这个智能体在列表、对话和运行时使用的基础配置。">
                  <div className="new-agent-grid-2">
                    <Field label="名称" required>
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

              {step === "tools" ? (
                <StepSection title="工具能力" subtitle="先选预设，再按能力类目微调。底层工具会自动展开保存。">
                  <div className="new-agent-tools-head">
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
                    <div className="new-agent-tools-buttons">
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
                  <Field label="Skills" hint="留空=全部可用，逗号分隔；输入 none 禁用">
                    <input
                      aria-label="Skills"
                      value={skillsText}
                      onChange={(e) => setSkillsText(e.target.value)}
                      placeholder="留空=全部可用"
                    />
                  </Field>
                </StepSection>
              ) : null}
            </main>

            <aside className="new-agent-preview" aria-label="实时预览">
              <div className="new-agent-preview-label">Live Preview</div>
              <div
                className="new-agent-preview-card"
                ref={previewRef}
                {...previewGloss}
              >
                <div
                  className="new-agent-preview-banner"
                  style={
                    {
                      "--banner-hue": hashHue(previewAgent.id).toString(),
                    } as React.CSSProperties
                  }
                />
                <div className="new-agent-preview-avatar-frame">
                  <AgentAvatar agent={previewAgent} size={54} shape="square" />
                </div>
                <div className="new-agent-preview-body">
                  <div className="new-agent-preview-name">{previewAgent.name}</div>
                  <div className="new-agent-preview-desc">{desc.trim() || tpl.desc}</div>
                  <div className="new-agent-preview-rows">
                    <PreviewRow label="Model" value={model || "gpt-5.5"} />
                    <PreviewRow label="Tools" value={`${selectedToolCount}`} />
                    <PreviewRow label="Skills" value={skillsSummary} />
                  </div>
                </div>
              </div>
              <div className="new-agent-preview-instructions">
                {previewInstructions || "选择模板并填写名称后，这里会显示最终创建时的行为摘要。"}
              </div>
            </aside>
          </div>
        </div>

        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={stepIndex === 0 ? close : goBack}>
            {stepIndex === 0 ? "取消" : "上一步"}
          </button>
          {step === STEPS[STEPS.length - 1].id ? (
            <button
              type="button"
              className="btn-primary new-agent-submit"
              onClick={submit}
              disabled={busy || !name.trim()}
            >
              {busy ? "创建中..." : "创建"}
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary new-agent-submit"
              onClick={goNext}
              disabled={!canGoNext}
            >
              继续
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StepSection(props: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <section className="new-agent-step">
      <div className="new-agent-step-head">
        <h2 className="new-agent-step-title">{props.title}</h2>
        <p className="new-agent-step-subtitle">{props.subtitle}</p>
      </div>
      {props.children}
    </section>
  );
}

function PreviewRow(props: { label: string; value: string }) {
  return (
    <div className="new-agent-preview-row">
      <span className="new-agent-preview-row-label">{props.label}</span>
      <span className="new-agent-preview-row-value">{props.value}</span>
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

const ICON_PROPS = {
  viewBox: "0 0 24 24",
  width: 22,
  height: 22,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function CheckSmall() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8.5l3 3 7-7" />
    </svg>
  );
}

function BlankIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="5" y="3.5" width="14" height="17" rx="2.5" />
      <path d="M9 8.5h6M9 12.5h6M9 16.5h4" />
    </svg>
  );
}

function WriterIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M4 19l3-1 11-11-2-2L5 16l-1 3z" />
      <path d="M14 6l2 2" />
    </svg>
  );
}

function ReviewerIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M9 4l-5 6 5 6" />
      <path d="M15 4l5 6-5 6" />
      <path d="M13 3l-2 18" />
    </svg>
  );
}

function ShellIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M7 10l3 2-3 2" />
      <path d="M12 14h5" />
    </svg>
  );
}
