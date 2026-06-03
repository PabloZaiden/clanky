/**
 * Zod schemas for preferences-related API requests.
 *
 * These schemas validate request bodies for user preference endpoints.
 *
 * @module types/schemas/preferences
 */

import { z } from "zod";
import { DEFAULT_QUICK_CHAT_SETTINGS, THEME_PREFERENCES, type QuickChatSettings } from "@clanky/shared";
import { CheapModelSelectionSchema, ModelConfigSchema } from "./model";

/**
 * Schema for setting last used model - PUT /api/preferences/last-model
 *
 * Uses the same ModelConfigSchema since it's the same structure.
 */
export const SetLastModelRequestSchema = ModelConfigSchema;

/**
 * Schema for setting last used cheap helper-model selection
 * - PUT /api/preferences/last-cheap-model
 */
export const SetLastCheapModelRequestSchema = CheapModelSelectionSchema;

/**
 * Schema for setting last used directory - PUT /api/preferences/last-directory
 */
export const SetLastDirectoryRequestSchema = z.object({
  directory: z.string().min(1, "directory is required"),
});

/**
 * Schema for setting markdown rendering preference - PUT /api/preferences/markdown-rendering
 */
export const SetMarkdownRenderingRequestSchema = z.object({
  enabled: z.boolean({ error: "enabled must be a boolean" }),
});

/**
 * Schema for setting file explorer full-tree loading preference
 * - PUT /api/preferences/file-explorer-full-tree
 */
export const SetFileExplorerFullTreeRequestSchema = z.object({
  enabled: z.boolean({ error: "enabled must be a boolean" }),
});

/**
 * Schema for setting log level - PUT /api/preferences/log-level
 */
export const SetLogLevelRequestSchema = z.object({
  level: z.string().min(1, "level is required"),
});

/**
 * Schema for setting dashboard view mode - PUT /api/preferences/dashboard-view-mode
 */
export const SetDashboardViewModeRequestSchema = z.object({
  mode: z.enum(["rows", "cards"], { error: "mode must be 'rows' or 'cards'" }),
});

/**
 * Schema for setting theme preference - PUT /api/preferences/theme
 */
export const SetThemePreferenceRequestSchema = z.object({
  theme: z.enum(THEME_PREFERENCES, {
    error: "theme must be 'light', 'dark', or 'system'",
  }),
});

export const QuickChatSettingsSchema = z.object({
  workspaceId: z.string().trim().default(""),
  model: ModelConfigSchema.nullable().default(null),
  useWorktree: z.boolean({ error: "useWorktree must be a boolean" }).default(false),
});

export const SetQuickChatSettingsRequestSchema = QuickChatSettingsSchema;

export function normalizeQuickChatSettings(value: unknown): QuickChatSettings {
  const validation = QuickChatSettingsSchema.safeParse(value);
  if (!validation.success) {
    return DEFAULT_QUICK_CHAT_SETTINGS;
  }
  return validation.data;
}
