/**
 * Stable per-id hue (0-359) used for AgentAvatar fill, AgentCard banner,
 * and the NewAgentModal preview banner. FNV-1a 32-bit modulo 360 — fast,
 * dependency-free, and stable across renders / processes.
 *
 * The 360-bucket palette means visual collisions are likely once the user
 * has ~20 agents (birthday paradox). Acceptable for now since the avatar
 * letter + name disambiguate; consider folding a second hash byte into
 * banner offsets if collisions become user-visible.
 */
export function hashHue(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h) % 360;
}
