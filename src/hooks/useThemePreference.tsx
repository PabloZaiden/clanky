/**
 * Hook and provider for managing the persisted application theme preference.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { ResolvedTheme, ThemePreference } from "../types/preferences";
import { DEFAULT_THEME_PREFERENCE } from "../types/preferences";
import { createLogger } from "../lib/logger";
import { appFetch } from "../lib/public-path";
import {
  applyThemeSnapshotToDocument,
  getStoredThemePreference,
  getSystemPrefersDark,
  getThemeSnapshot,
  saveStoredThemePreference,
  THEME_MEDIA_QUERY,
} from "../lib/theme";

export interface UseThemePreferenceResult {
  theme: ThemePreference;
  resolvedTheme: ResolvedTheme;
  loading: boolean;
  error: string | null;
  saving: boolean;
  setTheme: (theme: ThemePreference) => Promise<void>;
}

const ThemePreferenceContext = createContext<UseThemePreferenceResult | null>(null);

function getInitialThemePreference(): ThemePreference {
  return getStoredThemePreference() ?? DEFAULT_THEME_PREFERENCE;
}

export function ThemePreferenceProvider({ children }: { children: ReactNode }) {
  const log = createLogger("useThemePreference");
  const [theme, setThemeState] = useState<ThemePreference>(getInitialThemePreference);
  const [systemPrefersDark, setSystemPrefersDark] = useState(getSystemPrefersDark);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchPreference = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await appFetch("/api/preferences/theme");
      if (!response.ok) {
        throw new Error(`Failed to fetch theme preference: ${response.statusText}`);
      }
      const data = (await response.json()) as { theme: ThemePreference };
      setThemeState(data.theme);
      saveStoredThemePreference(data.theme);
    } catch (fetchError) {
      log.error("Failed to fetch theme preference", { error: String(fetchError) });
      setError(String(fetchError));
    } finally {
      setLoading(false);
    }
  }, []);

  const setTheme = useCallback(async (nextTheme: ThemePreference) => {
    try {
      setSaving(true);
      setError(null);
      const response = await appFetch("/api/preferences/theme", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ theme: nextTheme }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.message || "Failed to save theme preference");
      }

      setThemeState(nextTheme);
      saveStoredThemePreference(nextTheme);
    } catch (saveError) {
      log.error("Failed to save theme preference", {
        theme: nextTheme,
        error: String(saveError),
      });
      setError(String(saveError));
    } finally {
      setSaving(false);
    }
  }, []);

  useEffect(() => {
    void fetchPreference();
  }, [fetchPreference]);

  useEffect(() => {
    setSystemPrefersDark(getSystemPrefersDark());
    if (typeof window === "undefined" || typeof window.matchMedia !== "function" || theme !== "system") {
      return;
    }

    const mediaQuery = window.matchMedia(THEME_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setSystemPrefersDark(event.matches);
    };

    mediaQuery.addEventListener("change", handleChange);
    return () => {
      mediaQuery.removeEventListener("change", handleChange);
    };
  }, [theme]);

  useEffect(() => {
    if (typeof document === "undefined") {
      return;
    }

    applyThemeSnapshotToDocument(document, getThemeSnapshot(theme, systemPrefersDark));
  }, [theme, systemPrefersDark]);

  const value = useMemo<UseThemePreferenceResult>(() => {
    return {
      theme,
      resolvedTheme: getThemeSnapshot(theme, systemPrefersDark).resolvedTheme,
      loading,
      error,
      saving,
      setTheme,
    };
  }, [theme, systemPrefersDark, loading, error, saving, setTheme]);

  return (
    <ThemePreferenceContext.Provider value={value}>
      {children}
    </ThemePreferenceContext.Provider>
  );
}

export function useThemePreference(): UseThemePreferenceResult {
  const context = useContext(ThemePreferenceContext);
  if (!context) {
    throw new Error("useThemePreference must be used within a ThemePreferenceProvider");
  }
  return context;
}
