/**
 * Shared preference types for Clanky Tasks Management System.
 *
 * Types in this module are shared between the frontend (hooks)
 * and backend (persistence layer). They are the single source
 * of truth for preference value shapes.
 *
 * @module types/preferences
 */

/**
 * Dashboard view mode: either a list of rows or a grid of cards.
 */
export type DashboardViewMode = "rows" | "cards";

/**
 * Default theme preference when none is stored.
 */
export const DEFAULT_THEME_PREFERENCE = "system";

/**
 * Supported user-selectable theme modes.
 */
export const THEME_PREFERENCES = ["light", "dark", "system"] as const;

/**
 * Theme preference selected by the user.
 */
export type ThemePreference = typeof THEME_PREFERENCES[number];

/**
 * Concrete theme applied to the document after resolving `system`.
 */
export const RESOLVED_THEMES = ["light", "dark"] as const;

/**
 * Actual theme rendered by the UI.
 */
export type ResolvedTheme = typeof RESOLVED_THEMES[number];

export const DEFAULT_SCHEDULER_TIMEZONE = "UTC";

export function isValidIanaTimeZone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export interface QuickChatSettings {
  workspaceId: string;
  model: {
    providerID: string;
    modelID: string;
    variant: string;
  } | null;
  useWorktree: boolean;
}

export const DEFAULT_QUICK_CHAT_SETTINGS: QuickChatSettings = {
  workspaceId: "",
  model: null,
  useWorktree: false,
};
