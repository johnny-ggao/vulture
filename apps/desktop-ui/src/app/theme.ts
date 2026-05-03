export type ThemePreference = "system" | "light" | "dark";

const THEME_STORAGE_KEY = "vulture.theme";
const THEMES: readonly ThemePreference[] = ["system", "light", "dark"];

function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === "string" && THEMES.includes(value as ThemePreference);
}

export function applyThemePreference(preference: ThemePreference) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (preference === "system") {
    delete root.dataset.theme;
    root.style.removeProperty("color-scheme");
    return;
  }
  root.dataset.theme = preference;
  root.style.colorScheme = preference;
}

export function getThemePreference(): ThemePreference {
  if (typeof localStorage === "undefined") return "system";
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function setThemePreference(preference: ThemePreference) {
  if (typeof localStorage !== "undefined") {
    try {
      if (preference === "system") localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch {
      /* localStorage may be unavailable in restricted previews. */
    }
  }
  applyThemePreference(preference);
}
