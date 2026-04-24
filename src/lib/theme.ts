import {
  RESOLVED_THEMES,
  THEME_PREFERENCES,
  type ResolvedTheme,
  type ThemePreference,
} from "../types/preferences";
import { createLogger } from "./logger";

export { DEFAULT_THEME_PREFERENCE } from "../types/preferences";

const log = createLogger("theme");

export const THEME_STORAGE_KEY = "ralpher.themePreference";
export const THEME_DARK_CLASS = "dark";
export const THEME_MEDIA_QUERY = "(prefers-color-scheme: dark)";

const META_THEME_COLORS: Record<ResolvedTheme, string> = {
  light: "#f3f4f6",
  dark: "#171717",
};

export interface ThemeStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ThemeSnapshot {
  preference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  colorScheme: ResolvedTheme;
  darkClass: typeof THEME_DARK_CLASS;
  metaThemeColor: string;
}

export function isThemePreference(value: string): value is ThemePreference {
  return THEME_PREFERENCES.includes(value as ThemePreference);
}

export function isResolvedTheme(value: string): value is ResolvedTheme {
  return RESOLVED_THEMES.includes(value as ResolvedTheme);
}

export function resolveThemePreference(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") {
    return systemPrefersDark ? "dark" : "light";
  }

  return preference;
}

export function getThemeSnapshot(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ThemeSnapshot {
  const resolvedTheme = resolveThemePreference(preference, systemPrefersDark);

  return {
    preference,
    resolvedTheme,
    colorScheme: resolvedTheme,
    darkClass: THEME_DARK_CLASS,
    metaThemeColor: META_THEME_COLORS[resolvedTheme],
  };
}

function resolveThemeStorage(storage?: ThemeStorageLike): ThemeStorageLike | null {
  if (storage) {
    return storage;
  }
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch (error) {
    log.warn("Theme preference storage is unavailable", { error: String(error) });
    return null;
  }
}

export function getStoredThemePreference(storage?: ThemeStorageLike): ThemePreference | null {
  const resolvedStorage = resolveThemeStorage(storage);
  if (!resolvedStorage) {
    return null;
  }

  try {
    const stored = resolvedStorage.getItem(THEME_STORAGE_KEY);
    if (!stored) {
      return null;
    }
    if (!isThemePreference(stored)) {
      resolvedStorage.removeItem(THEME_STORAGE_KEY);
      return null;
    }
    return stored;
  } catch (error) {
    log.warn("Failed to read stored theme preference", { error: String(error) });
    return null;
  }
}

export function saveStoredThemePreference(
  theme: ThemePreference,
  storage?: ThemeStorageLike,
): void {
  const resolvedStorage = resolveThemeStorage(storage);
  if (!resolvedStorage) {
    return;
  }

  try {
    resolvedStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch (error) {
    log.warn("Failed to persist theme preference", {
      theme,
      error: String(error),
    });
  }
}

export function getSystemPrefersDark(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia(THEME_MEDIA_QUERY).matches;
}

export function applyThemeSnapshotToDocument(
  doc: Document,
  snapshot: ThemeSnapshot,
): void {
  const root = doc.documentElement;
  root.classList.toggle(snapshot.darkClass, snapshot.resolvedTheme === "dark");
  root.style.colorScheme = snapshot.colorScheme;
  root.dataset["themePreference"] = snapshot.preference;
  root.dataset["themeResolved"] = snapshot.resolvedTheme;

  const metaThemeColor = doc.querySelector('meta[name="theme-color"]');
  if (metaThemeColor instanceof HTMLMetaElement) {
    metaThemeColor.content = snapshot.metaThemeColor;
  }
}
