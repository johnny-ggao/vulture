import type { ReactNode } from "react";

/**
 * Preset registry for AgentAvatar.
 *
 * Each preset is a simple inline SVG that renders inside the avatar's
 * square, sized to fill ~80% of the box. The user picks one in
 * OverviewTab; the chosen `key` is what the gateway stores. When no
 * preset is selected (or the stored key is unknown), AgentAvatar falls
 * back to the deterministic letter-glyph avatar.
 *
 * Presets are intentionally vector-only and palette-aware — each one
 * carries its own colour pair so the user can pick something visually
 * distinct without us having to derive a hue.
 */
export interface AvatarPreset {
  key: string;
  label: string;
  /** Background fill for the avatar tile. Used as the AgentAvatar bg. */
  background: string;
  /** Foreground stroke / fill colour for the glyph. */
  foreground: string;
  /** Inline SVG glyph. Sized to a 16-unit viewBox; the consumer
   * scales it to fit the requested avatar size. */
  glyph: ReactNode;
}

/* ---- Glyphs (24-unit viewBox, stroke="currentColor") ----------- */

function GlyphSpark() {
  return (
    <svg viewBox="0 0 24 24" width="60%" height="60%" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v6M12 15v6M3 12h6M15 12h6" />
      <path d="M5.6 5.6l3 3M15.4 15.4l3 3M5.6 18.4l3-3M15.4 8.6l3-3" />
    </svg>
  );
}
function GlyphLeaf() {
  return (
    <svg viewBox="0 0 24 24" width="60%" height="60%" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 19c0-8 6-14 14-14 0 8-6 14-14 14Z" />
      <path d="M5 19c2-2 5-3 9-4" />
    </svg>
  );
}
function GlyphCompass() {
  return (
    <svg viewBox="0 0 24 24" width="60%" height="60%" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8" />
      <path d="M9 15l2-6 4-2-2 6Z" />
    </svg>
  );
}
function GlyphFlame() {
  return (
    <svg viewBox="0 0 24 24" width="60%" height="60%" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3c1 4 5 4 5 9a5 5 0 1 1-10 0c0-3 2-4 2-7 1 1 2 1 3-2Z" />
    </svg>
  );
}
function GlyphCircuit() {
  return (
    <svg viewBox="0 0 24 24" width="60%" height="60%" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="12" cy="18" r="2" />
      <path d="M8 6h8M6 8v8a2 2 0 0 0 2 2h2M18 8v8a2 2 0 0 1-2 2h-2" />
    </svg>
  );
}
function GlyphBook() {
  return (
    <svg viewBox="0 0 24 24" width="60%" height="60%" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 5v14a2 2 0 0 0 2 2h12V5a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2Z" />
      <path d="M9 7h6M9 11h6M9 15h4" />
    </svg>
  );
}
function GlyphAtom() {
  return (
    <svg viewBox="0 0 24 24" width="60%" height="60%" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="1.5" />
      <ellipse cx="12" cy="12" rx="9" ry="3.5" />
      <ellipse cx="12" cy="12" rx="9" ry="3.5" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="9" ry="3.5" transform="rotate(120 12 12)" />
    </svg>
  );
}
function GlyphHeart() {
  return (
    <svg viewBox="0 0 24 24" width="60%" height="60%" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10Z" />
    </svg>
  );
}
function GlyphPalette() {
  return (
    <svg viewBox="0 0 24 24" width="60%" height="60%" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a9 9 0 1 0 0 18 2 2 0 0 0 1.5-3.4 2 2 0 0 1 1.4-3.5h2.1a4 4 0 0 0 4-4 9 9 0 0 0-9-7Z" />
      <circle cx="8" cy="9" r="1" fill="currentColor" />
      <circle cx="13" cy="6.5" r="1" fill="currentColor" />
      <circle cx="17" cy="10" r="1" fill="currentColor" />
    </svg>
  );
}
function GlyphPlanet() {
  return (
    <svg viewBox="0 0 24 24" width="60%" height="60%" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="5" />
      <ellipse cx="12" cy="12" rx="10" ry="3" transform="rotate(-22 12 12)" />
    </svg>
  );
}

/* ---- Registry --------------------------------------------------- */

export const AVATAR_PRESETS: ReadonlyArray<AvatarPreset> = [
  { key: "spark",   label: "光芒",  background: "#fcb045", foreground: "#3a1f04", glyph: <GlyphSpark /> },
  { key: "leaf",    label: "新芽",  background: "#7ed7a3", foreground: "#0e3b21", glyph: <GlyphLeaf /> },
  { key: "compass", label: "罗盘",  background: "#5b8def", foreground: "#0c1f4d", glyph: <GlyphCompass /> },
  { key: "flame",   label: "火苗",  background: "#ec5d6a", foreground: "#3d0a10", glyph: <GlyphFlame /> },
  { key: "circuit", label: "电路",  background: "#9b7fde", foreground: "#1f1238", glyph: <GlyphCircuit /> },
  { key: "book",    label: "书籍",  background: "#d4a35a", foreground: "#3a2304", glyph: <GlyphBook /> },
  { key: "atom",    label: "原子",  background: "#3fc4c8", foreground: "#053236", glyph: <GlyphAtom /> },
  { key: "heart",   label: "暖心",  background: "#f48fb1", foreground: "#42102a", glyph: <GlyphHeart /> },
  { key: "palette", label: "调色",  background: "#a08bd9", foreground: "#1d1147", glyph: <GlyphPalette /> },
  { key: "planet",  label: "星球",  background: "#7d8cf3", foreground: "#0a1338", glyph: <GlyphPlanet /> },
];

const PRESET_BY_KEY = new Map(AVATAR_PRESETS.map((p) => [p.key, p]));

/** Lookup helper. Returns `null` when no preset matches the key. */
export function findAvatarPreset(key: string | undefined | null): AvatarPreset | null {
  if (!key) return null;
  return PRESET_BY_KEY.get(key) ?? null;
}
