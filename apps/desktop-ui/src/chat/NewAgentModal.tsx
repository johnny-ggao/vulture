import { useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import type {
  AgentToolName,
  AgentToolPreset,
  ReasoningLevel,
} from "../api/agents";
import type { ToolCatalogGroup, ToolPolicyDraft } from "../api/tools";
import { toolPolicyFromPreset } from "../api/tools";
import { AgentAvatar, hashHue } from "./components";
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
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Round 16: focus management — snapshot the trigger so we can
  // return focus to it after close (WAI-ARIA modal-dialog pattern,
  // matching AgentEditModal). aliveRef guards async setState after
  // unmount so a slow create doesn't poke a torn-down tree.
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!props.open) return;
    restoreFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    return () => {
      const node = restoreFocusRef.current;
      restoreFocusRef.current = null;
      queueMicrotask(() => node?.focus({ preventScroll: true }));
    };
  }, [props.open]);

  // Esc closes the wizard. If the user has typed anything in name /
  // description / instructions we ask first so a stray keypress can't
  // wipe a draft. Active only while open so the listener doesn't
  // compete with other modals' Esc handlers.
  useEffect(() => {
    if (!props.open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      if (busy) return; // wait for the create call to settle
      const dirty =
        name.trim().length > 0 ||
        desc.trim().length > 0 ||
        instructions.trim().length > 0;
      if (dirty && !window.confirm("有未提交的修改，确定要关闭吗？")) {
        return;
      }
      event.preventDefault();
      props.onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.open, busy, name, desc, instructions, props.onClose]);

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

  // Round 16: dirty signal for the create wizard. "Touched" means the
  // user has typed something we'd lose on close — name / description
  // / instructions / skills text. Identity-tweak fields like model /
  // reasoning / tool preset reset to defaults on cancel and aren't
  // worth confirming for. Tool selection from the default preset is
  // a wash; we don't try to detect it here.
  const isDirty =
    name.trim().length > 0 ||
    desc.trim().length > 0 ||
    instructions.trim().length > 0 ||
    skillsText.trim().length > 0;

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
    setSubmitError(null);
  }

  function close() {
    if (busy) return;
    // Match AgentEditModal: dirty close prompts before discarding work.
    if (isDirty) {
      if (!window.confirm("有未保存的修改，确定要关闭吗？")) return;
    }
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
    setSubmitError(null);
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
      if (!aliveRef.current) return;
      reset();
      props.onClose();
    } catch (cause) {
      // Round 16: surface the error inline (matches AgentEditModal
      // round 15) instead of silently swallowing it. The user keeps
      // their draft and can hit "重试" to re-submit.
      if (!aliveRef.current) return;
      const message =
        cause instanceof Error && cause.message
          ? cause.message
          : "创建失败，请重试。";
      setSubmitError(message);
      console.error("Agent create failed", cause);
    } finally {
      if (aliveRef.current) setBusy(false);
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
        {/* Top action bar — small chrome row holds only the close
          * button so the identity hero below can own the user's
          * attention. */}
        <div className="agent-edit-topbar">
          <span className="new-agent-step-pill" aria-hidden="true">
            步骤 {stepIndex + 1} / {STEPS.length}
          </span>
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

        {/* Identity hero — banner picks up the previewAgent hue (driven
          * by the typed name or the chosen template) so the colour
          * cross-fades as the user types. Floating avatar carries the
          * preview's first glyph. Title + current step meta sit
          * centred below. */}
        <div
          className="agent-edit-hero"
          style={
            {
              "--banner-hue": hashHue(previewAgent.id).toString(),
            } as React.CSSProperties
          }
        >
          <div className="agent-edit-hero-banner" aria-hidden="true" />
          <div className="agent-edit-hero-avatar">
            <AgentAvatar agent={previewAgent} size={56} shape="square" />
          </div>
          <h2 className="agent-edit-hero-name">
            {name.trim() || "新建智能体"}
          </h2>
          <div className="new-agent-step-meta">
            <span>{STEPS[stepIndex]?.label}</span>
            <span aria-hidden="true">·</span>
            <span className="new-agent-step-desc">{STEPS[stepIndex]?.desc}</span>
          </div>
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

        {submitError ? (
          <div
            className="agent-edit-error new-agent-error"
            role="alert"
            aria-live="assertive"
          >
            <span className="agent-edit-error-icon" aria-hidden="true">
              <NewAgentErrorIcon />
            </span>
            <span className="agent-edit-error-message">{submitError}</span>
            <button
              type="button"
              className="agent-edit-error-retry"
              disabled={busy}
              onClick={submit}
            >
              重试
            </button>
            <button
              type="button"
              className="agent-edit-error-dismiss"
              aria-label="关闭"
              onClick={() => setSubmitError(null)}
            >
              <NewAgentCloseSmallIcon />
            </button>
          </div>
        ) : null}

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
              {busy ? (
                <>
                  <span className="agent-edit-save-spinner" aria-hidden="true" />
                  创建中…
                </>
              ) : (
                "创建"
              )}
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

function NewAgentErrorIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M8 5v3.5" />
      <circle cx="8" cy="11" r="0.5" fill="currentColor" />
    </svg>
  );
}

function NewAgentCloseSmallIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="11"
      height="11"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M4 12l8-8" />
    </svg>
  );
}
