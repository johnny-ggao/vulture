import { hashHue } from "./agentHue";

export interface AgentAvatarProps {
  agent: { id: string; name: string };
  size?: number;
  shape?: "circle" | "square";
}

/**
 * Compact identity glyph for an agent. The hue is hashed deterministically
 * from `agent.id` so the same agent always renders the same colour across
 * the list, the chat header, and the new-agent preview. The visible glyph
 * is the first character of `agent.name`, capitalised — falling back to
 * `?` if the name is missing so we never render an empty box.
 *
 * The element is `aria-hidden` because the agent name is virtually always
 * adjacent and announcing the avatar separately would just add noise.
 */
export function AgentAvatar({
  agent,
  size = 32,
  shape = "circle",
}: AgentAvatarProps) {
  const hue = hashHue(agent.id);
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

