import type {
  Agent,
  AgentToolName,
  AgentToolPreset,
  ReasoningLevel,
} from "../../api/agents";

export interface AgentConfigPatch {
  name: string;
  description: string;
  model: string;
  reasoning: ReasoningLevel;
  tools: AgentToolName[];
  toolPreset: AgentToolPreset;
  toolInclude: AgentToolName[];
  toolExclude: AgentToolName[];
  handoffAgentIds: string[];
  skills?: string[] | null;
  instructions: string;
}

/** Editable draft state shared between the modal shell and each tab. */
export interface Draft {
  name: string;
  description: string;
  model: string;
  reasoning: ReasoningLevel;
  tools: AgentToolName[];
  toolPreset: AgentToolPreset;
  toolInclude: AgentToolName[];
  toolExclude: AgentToolName[];
  handoffAgentIds: string[];
  /**
   * Free-form skills input. The comma/newline-separated string lives in
   * the draft so the user can edit a "WIP" value without losing it; it is
   * normalised via `parseSkills` only at submit time.
   */
  skillsText: string;
  instructions: string;
}

/**
 * Map a saved Agent into a Draft. `null` is allowed so tabs can render
 * empty controls before an agent is selected (the modal returns null in
 * that case, but the helper stays safe).
 */
export function draftFromAgent(agent: Agent | null): Draft {
  return {
    name: agent?.name ?? "",
    description: agent?.description ?? "",
    model: agent?.model ?? "",
    reasoning: agent?.reasoning ?? "medium",
    tools: agent?.tools ? [...agent.tools] : [],
    toolPreset: agent?.toolPreset ?? "none",
    toolInclude: agent?.toolInclude ?? agent?.tools ?? [],
    toolExclude: agent?.toolExclude ?? [],
    handoffAgentIds: agent?.handoffAgentIds ? [...agent.handoffAgentIds] : [],
    skillsText:
      agent?.skills === undefined
        ? ""
        : agent.skills.length === 0
        ? "none"
        : agent.skills.join(", "),
    instructions: agent?.instructions ?? "",
  };
}

/**
 * Convert the free-form `skillsText` into the API's tri-state contract:
 *   `null`       — skills field omitted (server keeps default)
 *   `[]`         — explicit "none" (disable all skills for this agent)
 *   `[name…]`    — allowlist
 */
export function parseSkills(value: string): string[] | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.toLowerCase() === "none") return [];
  return trimmed
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Set-equality on two readonly string arrays — order doesn't matter. */
export function sameStringSet(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  for (const v of b) {
    if (!set.has(v)) return false;
  }
  return true;
}

/** Returns true when any field of the draft differs from the agent. */
export function isDirtyDraft(draft: Draft, agent: Agent | null): boolean {
  if (!agent) return false;
  const ref = draftFromAgent(agent);
  return (
    draft.name !== ref.name ||
    draft.description !== ref.description ||
    draft.model !== ref.model ||
    draft.reasoning !== ref.reasoning ||
    draft.toolPreset !== ref.toolPreset ||
    draft.skillsText !== ref.skillsText ||
    draft.instructions !== ref.instructions ||
    !sameStringSet(draft.tools, ref.tools) ||
    !sameStringSet(draft.toolInclude, ref.toolInclude) ||
    !sameStringSet(draft.toolExclude, ref.toolExclude) ||
    !sameStringSet(draft.handoffAgentIds, ref.handoffAgentIds)
  );
}

/**
 * Per-tab dirty signal — used by the modal tab strip to surface a dot
 * next to the tab whose fields the user has touched, so navigating
 * away mid-edit doesn't lose the cue. CoreTab edits live in their own
 * file-content state outside the Draft, so it's omitted here (the
 * tab's own "保存文件" button is the canonical save path for it).
 */
export type DraftTabKey = "overview" | "persona" | "tools";

export function dirtyTabs(
  draft: Draft,
  agent: Agent | null,
): ReadonlySet<DraftTabKey> {
  const dirty = new Set<DraftTabKey>();
  if (!agent) return dirty;
  const ref = draftFromAgent(agent);

  if (
    draft.name !== ref.name ||
    draft.description !== ref.description ||
    draft.model !== ref.model ||
    draft.reasoning !== ref.reasoning ||
    draft.skillsText !== ref.skillsText
  ) {
    dirty.add("overview");
  }

  if (draft.instructions !== ref.instructions) {
    dirty.add("persona");
  }

  if (
    draft.toolPreset !== ref.toolPreset ||
    !sameStringSet(draft.tools, ref.tools) ||
    !sameStringSet(draft.toolInclude, ref.toolInclude) ||
    !sameStringSet(draft.toolExclude, ref.toolExclude) ||
    !sameStringSet(draft.handoffAgentIds, ref.handoffAgentIds)
  ) {
    dirty.add("tools");
  }

  return dirty;
}
