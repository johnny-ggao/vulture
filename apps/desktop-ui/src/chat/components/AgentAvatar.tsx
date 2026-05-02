import { hashHue } from "./agentHue";
import { findAvatarPreset } from "./agentAvatarPresets";

export interface AgentAvatarProps {
  /**
   * `avatar` is an optional preset key from {@link AVATAR_PRESETS}.
   * When set + recognised, the avatar renders the preset's coloured
   * tile + glyph instead of the deterministic letter.
   */
  agent: { id: string; name: string; avatar?: string | null };
  size?: number;
  shape?: "circle" | "square";
}

/**
 * Compact identity glyph for an agent. Two render modes:
 *
 *   1. **Preset**: when `agent.avatar` matches a registered preset
 *      (see `agentAvatarPresets`), the avatar uses the preset's
 *      colour pair + inline SVG glyph. The user picks this in
 *      OverviewTab; the chosen key persists with the agent.
 *
 *   2. **Deterministic letter** (default): the hue is hashed from
 *      `agent.id` so the same agent always renders the same colour
 *      across the list, the chat header, and the new-agent preview.
 *      The visible glyph is the first character of `agent.name`,
 *      capitalised — falling back to `?` if the name is missing.
 *
 * The element is `aria-hidden` because the agent name is virtually
 * always adjacent and announcing the avatar separately would just
 * add noise.
 */
export function AgentAvatar({
  agent,
  size = 32,
  shape = "circle",
}: AgentAvatarProps) {
  const preset = findAvatarPreset(agent.avatar ?? null);
  if (preset) {
    return (
      <span
        className="agent-avatar agent-avatar-preset"
        aria-hidden="true"
        data-shape={shape}
        data-preset={preset.key}
        style={{
          width: `${size}px`,
          height: `${size}px`,
          backgroundColor: preset.background,
          color: preset.foreground,
        }}
      >
        {preset.glyph}
      </span>
    );
  }

  // `color:<seed>` avatar values feed the seed into the hash instead of
  // the agent id, so swapping seeds visibly changes the colour without
  // changing identity. Anything else falls back to the agent-id hash.
  const hueSeed =
    agent.avatar && agent.avatar.startsWith("color:")
      ? agent.avatar
      : agent.id;
  const hue = hashHue(hueSeed);
  // Defensive against callers that pass `name: undefined` through type
  // erasure or string coercion: a missing name should render `?`, never
  // throw inside `.trim()`.
  const initial = ((agent.name ?? "").trim().slice(0, 1) || "?").toUpperCase();
  const styles = {
    width: `${size}px`,
    height: `${size}px`,
    // Use HSL pairs that meet >= 4.5:1 contrast on white. We pick a saturated
    // mid tone for the background and a near-white foreground.
    backgroundColor: `hsl(${hue}deg 58% 42%)`,
    color: "#fff",
    fontSize: `${Math.round(size * 0.42)}px`,
  } as const;
  return (
    <span
      className="agent-avatar"
      aria-hidden="true"
      data-hue={hue}
      data-shape={shape}
      style={styles}
    >
      {initial}
    </span>
  );
}
