import { useMemo, useState } from "react";
import type {
  AgentToolName,
  AgentToolPreset,
  ReasoningLevel,
} from "../api/agents";
import type { ToolCatalogGroup, ToolPolicyDraft } from "../api/tools";
import { toolPolicyFromPreset } from "../api/tools";
import { parseSkills } from "./editAgentTabs";
import {
  IdentityStep,
  PersonaStep,
  PreviewCard,
  SkillsStep,
  STEPS,
  StepRail,
  TemplateStep,
  ToolsStep,
  TEMPLATES,
  type TemplateKey,
  type WizardStep,
} from "./newAgentSteps";

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

/**
 * 5-step wizard for creating a new agent. Owns all wizard state; each step
 * lives in its own controlled component under `./newAgentSteps/`. The shell
 * is just step routing + submit plumbing + the live preview aside.
 */
export function NewAgentModal(props: NewAgentModalProps) {
  const [step, setStep] = useState<WizardStep>("template");
  const [tplKey, setTplKey] = useState<TemplateKey>("blank");
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [model, setModel] = useState("gpt-5.5");
  const [reasoning, setReasoning] = useState<ReasoningLevel>("low");
  const [toolPolicy, setToolPolicy] = useState<ToolPolicyDraft>(() =>
    toolPolicyFromPreset("developer"),
  );
  const [skillsText, setSkillsText] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);

  const tpl = TEMPLATES.find((t) => t.key === tplKey)!;
  const stepIndex = STEPS.findIndex((item) => item.id === step);
  const canGoNext = step !== "identity" || name.trim().length > 0;
  const previewInstructions =
    instructions.trim() ||
    tpl.instructions ||
    (name.trim() ? `你是 ${name.trim()}。` : "");
  const skillsSummary = useMemo(() => {
    const parsed = parseSkills(skillsText);
    if (parsed === null) return "全部可用";
    if (parsed.length === 0) return "已禁用";
    return `${parsed.length} 个 allowlist`;
  }, [skillsText]);

  // Synthetic agent driving the live preview's banner hue + avatar letter.
  // Hashes on the entered name (so colour cross-fades as the user types);
  // falls back to the template key while the name is still empty.
  const previewAgent = {
    id: name.trim() || tpl.key,
    name: name.trim() || "新智能体",
  };

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

  /**
   * Rail click gate: identity + template are always reachable; later
   * steps require either having typed a name OR being already past the
   * jump target (i.e. the user has reached/seen them).
   */
  function isStepReachable(target: WizardStep, index: number): boolean {
    if (target === "template" || target === "identity") return true;
    if (name.trim()) return true;
    return index <= stepIndex;
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
  const isLastStep = step === STEPS[STEPS.length - 1].id;

  return (
    <div className="modal-overlay" onClick={close}>
      <div
        className="modal-card new-agent-modal"
        onClick={(e) => e.stopPropagation()}
      >
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
          <button
            type="button"
            className="icon-btn"
            onClick={close}
            aria-label="关闭"
            disabled={busy}
          >
            <svg
              viewBox="0 0 16 16"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4 4l8 8M4 12l8-8" />
            </svg>
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
            <StepRail
              step={step}
              onSelect={setStep}
              isReachable={isStepReachable}
            />

            <main className="new-agent-main">
              {step === "template" ? (
                <TemplateStep
                  selected={tplKey}
                  onSelect={(key, seed) => {
                    // Mirror the desc rule: a template only seeds the
                    // text fields when they're still empty, so users who
                    // step back from Persona and re-pick a template
                    // don't lose what they've typed.
                    setTplKey(key);
                    if (!instructions.trim()) setInstructions(seed.instructions);
                    if (!desc.trim()) setDesc(seed.desc);
                  }}
                />
              ) : null}

              {step === "identity" ? (
                <IdentityStep
                  name={name}
                  model={model}
                  reasoning={reasoning}
                  desc={desc}
                  descPlaceholder={tpl.desc}
                  onName={setName}
                  onModel={setModel}
                  onReasoning={setReasoning}
                  onDesc={setDesc}
                />
              ) : null}

              {step === "persona" ? (
                <PersonaStep
                  instructions={instructions}
                  placeholder={
                    tpl.instructions ||
                    "定义这个智能体的行为边界、工作方式和输出风格"
                  }
                  onChange={setInstructions}
                />
              ) : null}

              {step === "tools" ? (
                <ToolsStep
                  toolGroups={props.toolGroups}
                  toolPolicy={toolPolicy}
                  onChange={setToolPolicy}
                />
              ) : null}

              {step === "skills" ? (
                <SkillsStep skillsText={skillsText} onChange={setSkillsText} />
              ) : null}
            </main>

            <PreviewCard
              agent={previewAgent}
              desc={desc.trim() || tpl.desc}
              model={model || "gpt-5.5"}
              toolCount={toolPolicy.tools.length}
              skillsSummary={skillsSummary}
              instructionsPreview={previewInstructions}
            />
          </div>
        </div>

        <div className="modal-footer">
          <button
            type="button"
            className="btn-secondary"
            onClick={stepIndex === 0 ? close : goBack}
          >
            {stepIndex === 0 ? "取消" : "上一步"}
          </button>
          {isLastStep ? (
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
