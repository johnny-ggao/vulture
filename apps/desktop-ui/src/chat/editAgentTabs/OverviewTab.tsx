import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, ReasoningLevel } from "../../api/agents";
import type { AuthStatusView } from "../../commandCenterTypes";
import {
  AgentAvatar,
  AVATAR_PRESETS,
  Field,
  Segmented,
} from "../components";
import {
  validatedModelOptions,
  type ValidatedModelOption,
} from "../Settings/providerCatalog";
import type { Draft } from "./draft";
import { PERSONA_STARTERS } from "./personaStarters";

export interface OverviewTabProps {
  /** Null in create mode — Workspace path / id-bound info hide. */
  agent: Agent | null;
  draft: Draft;
  authStatus: AuthStatusView | null;
  onChange: (next: Draft) => void;
}

const REASONING_OPTIONS: ReadonlyArray<{
  value: ReasoningLevel;
  label: string;
}> = [
  { value: "low", label: "快速" },
  { value: "medium", label: "标准" },
  { value: "high", label: "深度" },
];

/* Avatar categories — Accio idiom. The "图标" tab pulls from the SVG
 * preset registry; "字符" maps to the deterministic letter avatar
 * (one tile per fallback hue); "色块" uses the same letter avatar but
 * forces an alternative hue seed so the user can pick a colour without
 * picking a glyph. The active category drives which row of tiles is
 * visible; the "重新生成" button reshuffles within the active group.
 */
type AvatarCategory = "icon" | "letter" | "color";

const AVATAR_CATEGORY_OPTIONS: ReadonlyArray<{
  value: AvatarCategory;
  label: string;
}> = [
  { value: "icon", label: "图标" },
  { value: "letter", label: "字符" },
  { value: "color", label: "色块" },
];

/** A handful of stable colour seeds used by the 色块 category — each
 *  one yields a distinct hue when fed through the deterministic
 *  letter-avatar hash, so picking one feels like picking a tile. */
const COLOR_SEEDS: ReadonlyArray<string> = [
  "color:rose",
  "color:amber",
  "color:lime",
  "color:teal",
  "color:sky",
  "color:violet",
  "color:slate",
  "color:fuchsia",
];

/**
 * Identity surface — name, model picker, reasoning level, description,
 * categorised avatar picker, and (in create mode) a "style" chip row
 * that seeds the persona body. Workspace path readout pinned at the
 * bottom in edit mode.
 */
export function OverviewTab({
  agent,
  draft,
  authStatus,
  onChange,
}: OverviewTabProps) {
  return (
    <div className="agent-config-panel" role="tabpanel">
      <div className="agent-config-grid">
        <Field label="名称">
          <input
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value })}
          />
        </Field>
        <ModelField
          value={draft.model}
          authStatus={authStatus}
          onChange={(model) => onChange({ ...draft, model })}
        />
        <Field
          label="推理强度"
          hint="低：响应更快；高：让模型思考更久，适合复杂任务。"
        >
          <Segmented
            ariaLabel="推理强度"
            value={draft.reasoning}
            options={REASONING_OPTIONS}
            onChange={(value) => onChange({ ...draft, reasoning: value })}
          />
        </Field>
      </div>
      <Field label="描述">
        <textarea
          rows={3}
          value={draft.description}
          onChange={(e) => onChange({ ...draft, description: e.target.value })}
        />
      </Field>
      <AvatarPicker
        agentId={agent?.id ?? (draft.name.trim() || "new-agent")}
        agentName={draft.name.trim() || "新建智能体"}
        selected={draft.avatar}
        onChange={(avatar) => onChange({ ...draft, avatar })}
      />
      {agent === null ? (
        <StyleSeedRow
          instructions={draft.instructions}
          onSeed={(body) => onChange({ ...draft, instructions: body })}
        />
      ) : null}
      {agent ? (
        <InfoBlock title="Workspace" value={agent.workspace.path} />
      ) : null}
    </div>
  );
}

/* ============================================================
 * Model picker — populated from configured providers only. Falls
 * back to a plain input when nothing is configured (so the user
 * isn't blocked from saving), and keeps the existing agent's
 * saved model in the dropdown even if its provider went away.
 * ============================================================ */
interface ModelFieldProps {
  value: string;
  authStatus: AuthStatusView | null;
  onChange: (next: string) => void;
}

function ModelField({ value, authStatus, onChange }: ModelFieldProps) {
  const options = useMemo(
    () => validatedModelOptions(authStatus, value || undefined),
    [authStatus, value],
  );

  // Group by provider so the <select> reads as "OpenAI > gpt-5.4"
  // rather than a flat soup of model ids.
  const groups = useMemo(() => groupByProvider(options), [options]);
  const hasOptions = options.length > 0;

  return (
    <Field
      label="模型"
      hint={
        hasOptions
          ? "仅显示已在「设置 → 模型」中配置的提供方对应模型。"
          : "尚未配置任何模型提供方。请到「设置 → 模型」中添加密钥。"
      }
    >
      {hasOptions ? (
        <select
          className="agent-model-select"
          aria-label="模型"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        >
          {value === "" ? (
            <option value="" disabled>
              选择模型…
            </option>
          ) : null}
          {groups.map((group) => (
            <optgroup key={group.providerId} label={group.providerName}>
              {group.options.map((opt) => (
                <option key={opt.model.id} value={opt.model.id}>
                  {opt.model.id}
                  {opt.model.hint ? ` — ${opt.model.hint}` : ""}
                  {opt.configured ? "" : "（未配置）"}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      ) : (
        <input
          aria-label="模型"
          value={value}
          placeholder="尚未配置任何提供方"
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

interface ProviderGroup {
  providerId: string;
  providerName: string;
  options: ValidatedModelOption[];
}

function groupByProvider(options: ValidatedModelOption[]): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>();
  for (const opt of options) {
    const id = opt.provider.id;
    let group = groups.get(id);
    if (!group) {
      group = {
        providerId: id,
        providerName: opt.provider.name,
        options: [],
      };
      groups.set(id, group);
    }
    group.options.push(opt);
  }
  return Array.from(groups.values());
}

/* ============================================================
 * Avatar picker — categories + regenerate. Mirrors Accio's
 * "switch tab to change family, hit ↻ for a fresh take" idiom.
 * ============================================================ */
interface AvatarPickerProps {
  agentId: string;
  agentName: string;
  selected: string;
  onChange: (next: string) => void;
}

function AvatarPicker({
  agentId,
  agentName,
  selected,
  onChange,
}: AvatarPickerProps) {
  const previewAgent = { id: agentId, name: agentName, avatar: selected };

  const initialCategory: AvatarCategory = useMemo(() => {
    if (!selected) return "letter";
    if (selected.startsWith("color:")) return "color";
    if (AVATAR_PRESETS.some((p) => p.key === selected)) return "icon";
    return "letter";
  }, [selected]);
  const [category, setCategory] = useState<AvatarCategory>(initialCategory);
  // When the underlying selection changes from outside (e.g. Draft
  // reset on agent switch), follow it so the visible category matches.
  const lastSyncedRef = useRef(selected);
  useEffect(() => {
    if (selected === lastSyncedRef.current) return;
    lastSyncedRef.current = selected;
    setCategory(initialCategory);
  }, [selected, initialCategory]);

  /** "重新生成" — picks the next preset within the active category
   *  so the user always sees the change without leaving the tab. */
  function regenerate() {
    if (category === "icon") {
      const idx = AVATAR_PRESETS.findIndex((p) => p.key === selected);
      const next =
        AVATAR_PRESETS[(idx + 1 + AVATAR_PRESETS.length) % AVATAR_PRESETS.length];
      if (next) onChange(next.key);
    } else if (category === "color") {
      const idx = COLOR_SEEDS.indexOf(selected);
      const next = COLOR_SEEDS[(idx + 1 + COLOR_SEEDS.length) % COLOR_SEEDS.length];
      if (next) onChange(next);
    } else {
      // 字符 = deterministic letter from the agent's name. There's
      // only one canonical letter avatar, so "regenerate" clears any
      // override and re-derives from the current name.
      onChange("");
    }
  }

  return (
    <div className="agent-avatar-picker" role="group" aria-label="头像">
      <div className="agent-avatar-picker-header">
        <span className="agent-avatar-picker-label">头像</span>
        <button
          type="button"
          className="agent-avatar-regenerate"
          onClick={regenerate}
          aria-label="重新生成头像"
          title="重新生成"
        >
          <RegenerateIcon />
          <span>重新生成</span>
        </button>
      </div>
      <Segmented
        ariaLabel="头像分类"
        value={category}
        options={AVATAR_CATEGORY_OPTIONS}
        onChange={setCategory}
      />
      <div className="agent-avatar-picker-row">
        <div className="agent-avatar-picker-preview" aria-hidden="true">
          <AgentAvatar agent={previewAgent} size={64} shape="square" />
        </div>
        <div
          className="agent-avatar-picker-grid"
          role="radiogroup"
          aria-label={`选择${categoryLabel(category)}头像`}
        >
          {category === "icon" ? (
            <>
              <AvatarTile
                title="默认"
                ariaLabel="默认（按名称首字母）"
                active={selected === ""}
                onClick={() => onChange("")}
              >
                <AgentAvatar
                  agent={{ id: agentId, name: agentName }}
                  size={36}
                  shape="square"
                />
              </AvatarTile>
              {AVATAR_PRESETS.map((preset) => (
                <AvatarTile
                  key={preset.key}
                  title={preset.label}
                  ariaLabel={preset.label}
                  active={selected === preset.key}
                  onClick={() => onChange(preset.key)}
                >
                  <AgentAvatar
                    agent={{ id: agentId, name: agentName, avatar: preset.key }}
                    size={36}
                    shape="square"
                  />
                </AvatarTile>
              ))}
            </>
          ) : null}
          {category === "letter" ? (
            <AvatarTile
              title="按名称首字母生成"
              ariaLabel="按名称首字母生成"
              active={selected === ""}
              onClick={() => onChange("")}
            >
              <AgentAvatar
                agent={{ id: agentId, name: agentName }}
                size={36}
                shape="square"
              />
            </AvatarTile>
          ) : null}
          {category === "color" ? (
            <>
              {COLOR_SEEDS.map((seed) => (
                <AvatarTile
                  key={seed}
                  title={seed.replace("color:", "")}
                  ariaLabel={`色块 ${seed.replace("color:", "")}`}
                  active={selected === seed}
                  onClick={() => onChange(seed)}
                >
                  <AgentAvatar
                    agent={{
                      id: agentId,
                      name: agentName,
                      avatar: seed,
                    }}
                    size={36}
                    shape="square"
                  />
                </AvatarTile>
              ))}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function categoryLabel(c: AvatarCategory): string {
  if (c === "icon") return "图标";
  if (c === "color") return "色块";
  return "字符";
}

interface AvatarTileProps {
  active: boolean;
  ariaLabel: string;
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}

function AvatarTile({
  active,
  ariaLabel,
  title,
  onClick,
  children,
}: AvatarTileProps) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-label={ariaLabel}
      title={title}
      className={"agent-avatar-tile" + (active ? " active" : "")}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function RegenerateIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8a5 5 0 0 1 8.5-3.5L13 6" />
      <path d="M13 3v3h-3" />
      <path d="M13 8a5 5 0 0 1-8.5 3.5L3 10" />
      <path d="M3 13v-3h3" />
    </svg>
  );
}

/* ============================================================
 * Style seed row — shown only in create mode. Clicking a chip
 * seeds the persona body so the AGENTS.md core file (created on
 * first save) starts from a working scaffold instead of a blank
 * page. Disabled (chip is non-blocking, just visually muted) when
 * the user already typed something so we don't clobber a draft.
 * ============================================================ */
interface StyleSeedRowProps {
  instructions: string;
  onSeed: (body: string) => void;
}

function StyleSeedRow({ instructions, onSeed }: StyleSeedRowProps) {
  const isEmpty = instructions.trim().length === 0;
  return (
    <div className="agent-style-seed" role="group" aria-label="人格风格">
      <div className="agent-style-seed-head">
        <span className="agent-style-seed-label">人格风格</span>
        <span className="agent-style-seed-hint">
          {isEmpty
            ? "选择一个起点，创建后会写入「核心文件」。"
            : "已经选择了风格 — 在创建后可以在「核心文件」中继续微调。"}
        </span>
      </div>
      <div className="agent-style-seed-row">
        {PERSONA_STARTERS.map((starter) => {
          const active = instructions === starter.body;
          return (
            <button
              key={starter.label}
              type="button"
              className={
                "agent-style-seed-chip" + (active ? " active" : "")
              }
              onClick={() => onSeed(starter.body)}
            >
              {starter.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function InfoBlock(props: { title: string; value: string }) {
  return (
    <div className="agent-info-block">
      <div className="agent-info-label">{props.title}</div>
      <div className="agent-info-row">
        <code className="agent-info-value">{props.value}</code>
        {props.value ? <CopyValueButton value={props.value} /> : null}
      </div>
    </div>
  );
}

/**
 * Tiny "copy to clipboard" affordance reused for the Workspace path
 * (and any other read-only mono value the modal surfaces).
 */
function CopyValueButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    },
    [],
  );
  async function copy() {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      }
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      setCopied(true);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — silently fall back; the icon just
      // doesn't flash 已复制.
    }
  }
  return (
    <button
      type="button"
      className="agent-info-copy"
      onClick={copy}
      aria-label={`复制 ${value}`}
      title="复制路径"
      data-copied={copied || undefined}
    >
      {copied ? (
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 8.5l3 3 7-7" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 16 16"
          width="12"
          height="12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="5" y="5" width="8" height="9" rx="1.5" />
          <path d="M3 11V3.5A1.5 1.5 0 0 1 4.5 2H10" />
        </svg>
      )}
    </button>
  );
}
