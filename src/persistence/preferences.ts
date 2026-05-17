/**
 * User preferences persistence for Ralph Loops Management System.
 * Stores user preferences in SQLite database using a key-value pattern.
 * 
 * Note: Server settings are now stored per-workspace, not globally.
 * See src/persistence/workspaces.ts for workspace-specific server settings.
 * 
 * Note: Exported functions are marked `async` despite using synchronous
 * bun:sqlite APIs. This is intentional for interface consistency — callers
 * already `await` these functions, and the persistence layer may switch to
 * async storage in the future.
 */

import { getDatabase } from "./database";
import { createLogger } from "../core/logger";
import {
  DEFAULT_THEME_PREFERENCE,
  DEFAULT_QUICK_CHAT_SETTINGS,
  THEME_PREFERENCES,
  type DashboardViewMode,
  type QuickChatSettings,
  type ThemePreference,
} from "../types/preferences";
import { CheapModelSelectionSchema } from "../types/schemas/model";
import type { CheapModelSelection } from "../types";

const log = createLogger("persistence:preferences");

/**
 * Re-export DashboardViewMode so existing consumers of this module don't break.
 */
export type { DashboardViewMode } from "../types/preferences";

/**
 * Valid dashboard view mode values for validation.
 */
const VALID_VIEW_MODES: DashboardViewMode[] = ["rows", "cards"];
const VALID_THEME_PREFERENCES: ThemePreference[] = [...THEME_PREFERENCES];

/**
 * Default dashboard view mode when no preference is set.
 */
export const DEFAULT_VIEW_MODE: DashboardViewMode = "rows";

/**
 * Default file explorer loading mode when no preference is set.
 */
export const DEFAULT_FILE_EXPLORER_FULL_TREE = true;

/**
 * Valid log level names.
 */
export type LogLevelName = "silly" | "trace" | "debug" | "info" | "warn" | "error" | "fatal";

/**
 * Default log level when no preference is set.
 */
export const DEFAULT_LOG_LEVEL: LogLevelName = "info";

/**
 * User preferences structure.
 */
export interface UserPreferences {
  /** Last used model selection */
  lastModel?: {
    providerID: string;
    modelID: string;
    /** Model variant (e.g., "thinking"). Empty string or undefined for default. */
    variant?: string;
  };
  /** Last used helper-model selection for cheap operations */
  lastCheapModel?: CheapModelSelection;
  /** Last used working directory for loop creation */
  lastDirectory?: string;
  /** Whether markdown rendering is enabled (defaults to true) */
  markdownRenderingEnabled?: boolean;
  /** Whether the file explorer loads the entire tree in one request (defaults to true) */
  fileExplorerFullTreeEnabled?: boolean;
  /** Log level for both frontend and backend (defaults to "info") */
  logLevel?: LogLevelName;
  /** Dashboard view mode (defaults to "rows") */
  dashboardViewMode?: DashboardViewMode;
  /** Visual theme preference (defaults to "system") */
  themePreference?: ThemePreference;
  /** Quick chat workspace/model settings */
  quickChatSettings?: QuickChatSettings;
}

/**
 * Get a preference value by key.
 */
function getPreference(key: string): string | null {
  log.trace("Getting preference", { key });
  const db = getDatabase();
  const stmt = db.prepare("SELECT value FROM preferences WHERE key = ?");
  const row = stmt.get(key) as { value: string } | null;
  const value = row?.value ?? null;
  log.trace("Preference retrieved", { key, found: value !== null });
  return value;
}

/**
 * Set a preference value by key.
 */
function setPreference(key: string, value: string): void {
  log.debug("Setting preference", { key });
  const db = getDatabase();
  const stmt = db.prepare(`
    INSERT INTO preferences (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  stmt.run(key, value);
  log.trace("Preference set", { key });
}

/**
 * Get the last used model.
 */
export async function getLastModel(): Promise<UserPreferences["lastModel"]> {
  log.debug("Getting last model preference");
  const lastModelJson = getPreference("lastModel");
  if (!lastModelJson) {
    log.trace("No last model preference found");
    return undefined;
  }
  
  try {
    const model = JSON.parse(lastModelJson);
    log.trace("Last model preference retrieved", { providerID: model.providerID, modelID: model.modelID, variant: model.variant });
    return model;
  } catch {
    log.warn("Failed to parse last model preference");
    return undefined;
  }
}

/**
 * Set the last used model.
 */
export async function setLastModel(model: {
  providerID: string;
  modelID: string;
  variant?: string;
}): Promise<void> {
  log.debug("Setting last model preference", { providerID: model.providerID, modelID: model.modelID, variant: model.variant });
  setPreference("lastModel", JSON.stringify(model));
}

/**
 * Get the last used cheap helper-model selection.
 */
export async function getLastCheapModel(): Promise<UserPreferences["lastCheapModel"]> {
  log.debug("Getting last cheap model preference");
  const lastCheapModelJson = getPreference("lastCheapModel");
  if (!lastCheapModelJson) {
    log.trace("No last cheap model preference found");
    return undefined;
  }

  try {
    const parsed = JSON.parse(lastCheapModelJson);
    const validation = CheapModelSelectionSchema.safeParse(parsed);
    if (!validation.success) {
      log.warn("Failed to validate last cheap model preference", {
        issues: validation.error.issues.map((issue) => issue.message),
      });
      return undefined;
    }
    return validation.data;
  } catch (error) {
    log.warn("Failed to parse last cheap model preference", {
      error: String(error),
    });
    return undefined;
  }
}

/**
 * Set the last used cheap helper-model selection.
 */
export async function setLastCheapModel(selection: CheapModelSelection): Promise<void> {
  log.debug("Setting last cheap model preference", { mode: selection.mode });
  setPreference("lastCheapModel", JSON.stringify(selection));
}

/**
 * Get the last used working directory.
 */
export async function getLastDirectory(): Promise<string | undefined> {
  log.debug("Getting last directory preference");
  const dir = getPreference("lastDirectory") ?? undefined;
  log.trace("Last directory preference", { found: dir !== undefined });
  return dir;
}

/**
 * Set the last used working directory.
 */
export async function setLastDirectory(directory: string): Promise<void> {
  log.debug("Setting last directory preference", { directory });
  setPreference("lastDirectory", directory);
}

/**
 * Get whether markdown rendering is enabled.
 * Defaults to true if not set.
 */
export async function getMarkdownRenderingEnabled(): Promise<boolean> {
  log.debug("Getting markdown rendering preference");
  const value = getPreference("markdownRenderingEnabled");
  if (value === null) {
    log.trace("Markdown rendering preference not set, using default", { default: true });
    return true; // Default to enabled
  }
  const enabled = value === "true";
  log.trace("Markdown rendering preference", { enabled });
  return enabled;
}

/**
 * Set whether markdown rendering is enabled.
 */
export async function setMarkdownRenderingEnabled(enabled: boolean): Promise<void> {
  log.debug("Setting markdown rendering preference", { enabled });
  setPreference("markdownRenderingEnabled", String(enabled));
}

/**
 * Get whether the file explorer should load the full tree at once.
 * Defaults to true if not set.
 */
export async function getFileExplorerFullTreeEnabled(): Promise<boolean> {
  log.debug("Getting file explorer full-tree preference");
  const value = getPreference("fileExplorerFullTreeEnabled");
  if (value === null) {
    log.trace("File explorer full-tree preference not set, using default", {
      default: DEFAULT_FILE_EXPLORER_FULL_TREE,
    });
    return DEFAULT_FILE_EXPLORER_FULL_TREE;
  }
  const enabled = value === "true";
  log.trace("File explorer full-tree preference", { enabled });
  return enabled;
}

/**
 * Set whether the file explorer should load the full tree at once.
 */
export async function setFileExplorerFullTreeEnabled(enabled: boolean): Promise<void> {
  log.debug("Setting file explorer full-tree preference", { enabled });
  setPreference("fileExplorerFullTreeEnabled", String(enabled));
}

/**
 * Valid log levels for validation.
 */
const VALID_LOG_LEVELS: LogLevelName[] = ["silly", "trace", "debug", "info", "warn", "error", "fatal"];

/**
 * Get the log level preference.
 * Defaults to "info" if not set.
 */
export async function getLogLevelPreference(): Promise<LogLevelName> {
  log.debug("Getting log level preference");
  const value = getPreference("logLevel");
  if (value === null) {
    log.trace("Log level preference not set, using default", { default: DEFAULT_LOG_LEVEL });
    return DEFAULT_LOG_LEVEL;
  }
  // Validate the stored value is a valid log level
  if (VALID_LOG_LEVELS.includes(value as LogLevelName)) {
    log.trace("Log level preference", { level: value });
    return value as LogLevelName;
  }
  log.warn("Invalid log level preference, using default", { storedValue: value, default: DEFAULT_LOG_LEVEL });
  return DEFAULT_LOG_LEVEL;
}

/**
 * Set the log level preference.
 */
export async function setLogLevelPreference(level: LogLevelName): Promise<void> {
  log.debug("Setting log level preference", { level });
  // Validate the level before storing
  if (!VALID_LOG_LEVELS.includes(level)) {
    log.error("Invalid log level provided", { level, validLevels: VALID_LOG_LEVELS });
    throw new Error(`Invalid log level: ${level}. Valid levels are: ${VALID_LOG_LEVELS.join(", ")}`);
  }
  setPreference("logLevel", level);
}

/**
 * Get the dashboard view mode preference.
 * Defaults to "rows" if not set.
 */
export async function getDashboardViewMode(): Promise<DashboardViewMode> {
  log.debug("Getting dashboard view mode preference");
  const value = getPreference("dashboardViewMode");
  if (value === null) {
    log.trace("Dashboard view mode preference not set, using default", { default: DEFAULT_VIEW_MODE });
    return DEFAULT_VIEW_MODE;
  }
  if (VALID_VIEW_MODES.includes(value as DashboardViewMode)) {
    log.trace("Dashboard view mode preference", { mode: value });
    return value as DashboardViewMode;
  }
  log.warn("Invalid dashboard view mode preference, using default", { storedValue: value, default: DEFAULT_VIEW_MODE });
  return DEFAULT_VIEW_MODE;
}

/**
 * Set the dashboard view mode preference.
 */
export async function setDashboardViewMode(mode: DashboardViewMode): Promise<void> {
  log.debug("Setting dashboard view mode preference", { mode });
  if (!VALID_VIEW_MODES.includes(mode)) {
    log.error("Invalid dashboard view mode provided", { mode, validModes: VALID_VIEW_MODES });
    throw new Error(`Invalid dashboard view mode: ${mode}. Valid modes are: ${VALID_VIEW_MODES.join(", ")}`);
  }
  setPreference("dashboardViewMode", mode);
}

/**
 * Get the visual theme preference.
 * Defaults to "system" if not set.
 */
export async function getThemePreference(): Promise<ThemePreference> {
  log.debug("Getting theme preference");
  const value = getPreference("themePreference");
  if (value === null) {
    log.trace("Theme preference not set, using default", { default: DEFAULT_THEME_PREFERENCE });
    return DEFAULT_THEME_PREFERENCE;
  }
  if (VALID_THEME_PREFERENCES.includes(value as ThemePreference)) {
    log.trace("Theme preference", { theme: value });
    return value as ThemePreference;
  }
  log.warn("Invalid theme preference, using default", {
    storedValue: value,
    default: DEFAULT_THEME_PREFERENCE,
  });
  return DEFAULT_THEME_PREFERENCE;
}

/**
 * Set the visual theme preference.
 */
export async function setThemePreference(theme: ThemePreference): Promise<void> {
  log.debug("Setting theme preference", { theme });
  if (!VALID_THEME_PREFERENCES.includes(theme)) {
    log.error("Invalid theme preference provided", {
      theme,
      validThemes: VALID_THEME_PREFERENCES,
    });
    throw new Error(
      `Invalid theme preference: ${theme}. Valid themes are: ${VALID_THEME_PREFERENCES.join(", ")}`,
    );
  }
  setPreference("themePreference", theme);
}

function normalizeQuickChatSettings(value: unknown): QuickChatSettings {
  if (!value || typeof value !== "object") {
    return DEFAULT_QUICK_CHAT_SETTINGS;
  }

  const candidate = value as Record<string, unknown>;
  const workspaceId = typeof candidate["workspaceId"] === "string"
    ? candidate["workspaceId"].trim()
    : "";
  const modelCandidate = candidate["model"];
  const model = modelCandidate && typeof modelCandidate === "object"
    ? modelCandidate as Record<string, unknown>
    : null;

  if (!model) {
    return { workspaceId, model: null };
  }

  const providerID = typeof model["providerID"] === "string" ? model["providerID"].trim() : "";
  const modelID = typeof model["modelID"] === "string" ? model["modelID"].trim() : "";
  const variant = typeof model["variant"] === "string" ? model["variant"] : "";

  if (!providerID || !modelID) {
    return { workspaceId, model: null };
  }

  return {
    workspaceId,
    model: {
      providerID,
      modelID,
      variant,
    },
  };
}

export async function getQuickChatSettings(): Promise<QuickChatSettings> {
  log.debug("Getting quick chat settings preference");
  const quickChatSettingsJson = getPreference("quickChatSettings");
  if (!quickChatSettingsJson) {
    log.trace("Quick chat settings preference not set, using default");
    return DEFAULT_QUICK_CHAT_SETTINGS;
  }

  try {
    return normalizeQuickChatSettings(JSON.parse(quickChatSettingsJson));
  } catch (error) {
    log.warn("Failed to parse quick chat settings preference", {
      error: String(error),
    });
    return DEFAULT_QUICK_CHAT_SETTINGS;
  }
}

export async function setQuickChatSettings(settings: QuickChatSettings): Promise<void> {
  const normalized = normalizeQuickChatSettings(settings);
  log.debug("Setting quick chat settings preference", {
    workspaceId: normalized.workspaceId,
    hasModel: normalized.model !== null,
  });
  setPreference("quickChatSettings", JSON.stringify(normalized));
}
