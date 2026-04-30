import { useEffect, useRef } from "react";
import type { SkillListItem } from "../api/skills";
import { Badge, Toggle } from "./components";

export interface SkillDetailModalProps {
  open: boolean;
  skill: SkillListItem | null;
  saving: boolean;
  onClose: () => void;
  onToggle: (skill: SkillListItem) => void;
}

const SOURCE_LABEL: Record<SkillListItem["source"], string> = {
  workspace: "Workspace",
  profile: "Profile",
};

/**
 * Read-only detail view for a single skill. Currently the only mutation
 * is the enable/disable Toggle; description / file path / source are all
 * inherited from the skill bundle on disk and not editable in-app.
 */
export function SkillDetailModal({
  open,
  skill,
  saving,
  onClose,
  onToggle,
}: SkillDetailModalProps) {
  // Esc closes — same contract as AgentEditModal. Read `onClose` + `saving`
  // through a ref so the listener doesn't rebind on every parent render
  // where the handler arrives as an inline arrow. Esc, overlay-click, and
  // the close button ALL gate on `saving` so a mid-toggle dismiss can't
  // strand the request. Ref is committed in an effect, not during render,
  // to stay safe under StrictMode / concurrent rendering.
  const escDepsRef = useRef({ onClose, saving });
  useEffect(() => {
    escDepsRef.current = { onClose, saving };
  });
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      const { saving: isSaving, onClose: close } = escDepsRef.current;
      if (!isSaving) close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  function attemptClose() {
    if (!saving) onClose();
  }

  if (!open || !skill) return null;

  return (
    <div className="modal-overlay" onClick={attemptClose}>
      <div
        className="modal-card skill-detail-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="skill-detail-title-block">
            <span className="modal-title">{skill.name}</span>
            <div className="skill-detail-badges">
              <Badge tone="brand">{SOURCE_LABEL[skill.source]}</Badge>
              <Badge tone={skill.modelInvocationEnabled ? "info" : "neutral"}>
                {skill.modelInvocationEnabled ? "模型可见" : "仅手动"}
              </Badge>
              {!skill.enabled ? <Badge tone="neutral">已禁用</Badge> : null}
            </div>
          </div>
          <div className="skill-detail-actions">
            <Toggle
              ariaLabel={`${skill.enabled ? "禁用" : "启用"} ${skill.name}`}
              checked={skill.enabled}
              disabled={saving}
              onChange={() => onToggle(skill)}
            />
            <button
              type="button"
              className="icon-btn"
              aria-label="关闭"
              disabled={saving}
              onClick={attemptClose}
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
        </div>

        <div className="modal-body skill-detail-body">
          <div className="skill-detail-section">
            <h3 className="skill-detail-section-title">描述</h3>
            <p className="skill-detail-description">
              {skill.description || "（这个 skill 没有描述。）"}
            </p>
          </div>

          <div className="skill-detail-section">
            <h3 className="skill-detail-section-title">文件路径</h3>
            <code className="skill-detail-path">{skill.filePath}</code>
          </div>

          <div className="skill-detail-section">
            <h3 className="skill-detail-section-title">基目录</h3>
            <code className="skill-detail-path">{skill.baseDir}</code>
          </div>
        </div>
      </div>
    </div>
  );
}
