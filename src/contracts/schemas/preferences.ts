/**
 * Zod schemas for preferences-related API requests.
 *
 * These schemas validate request bodies for user preference endpoints.
 *
 * @module contracts/schemas/preferences
 */

import { z } from "zod";
import {
  DEFAULT_QUICK_CHAT_SETTINGS,
  isValidIanaTimeZone,
  PROMPT_TEMPLATE_LIMITS,
  type QuickChatSettings,
} from "@/shared";
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
 * Schema for setting the user's GitHub username.
 * An empty string clears the optional preference.
 */
export const SetGithubUsernameRequestSchema = z.object({
  githubUsername: z.string().trim().refine(
    (value) => value === ""
      || /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value),
    {
      message: "GitHub username must use GitHub login syntax and be at most 39 characters",
    },
  ),
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
 * Schema for setting dashboard view mode - PUT /api/preferences/dashboard-view-mode
 */
export const SetDashboardViewModeRequestSchema = z.object({
  mode: z.enum(["rows", "cards"], { error: "mode must be 'rows' or 'cards'" }),
});

export const SetSchedulerTimezoneRequestSchema = z.object({
  timezone: z.string().trim().min(1, "timezone is required").refine(
    isValidIanaTimeZone,
    { message: "timezone must be a valid IANA timezone" },
  ),
});

export const SchedulerTimezoneQuerySchema = z.object({
  workspaceId: z.string().min(1).optional(),
});

export const QuickChatSettingsSchema = z.object({
  workspaceId: z.string().trim().default(""),
  model: ModelConfigSchema.nullable().default(null),
  useWorktree: z.boolean({ error: "useWorktree must be a boolean" }).default(false),
});

export const SetQuickChatSettingsRequestSchema = QuickChatSettingsSchema;

export const PromptTemplateSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1, "name is required").max(PROMPT_TEMPLATE_LIMITS.nameLength),
  description: z.string().trim().max(PROMPT_TEMPLATE_LIMITS.descriptionLength),
  prompt: z.string().max(PROMPT_TEMPLATE_LIMITS.promptLength).refine(
    (value) => value.trim().length > 0,
    { message: "prompt is required" },
  ),
});

export const PromptTemplateListSchema = z.array(PromptTemplateSchema)
  .max(PROMPT_TEMPLATE_LIMITS.count)
  .superRefine((templates, context) => {
    const ids = new Set<string>();
    templates.forEach((template, index) => {
      if (ids.has(template.id)) {
        context.addIssue({
          code: "custom",
          message: "template IDs must be unique",
          path: [index, "id"],
        });
      }
      ids.add(template.id);
    });
  });

export const SetPromptTemplatesRequestSchema = z.object({
  templates: PromptTemplateListSchema,
});

export function normalizeQuickChatSettings(value: unknown): QuickChatSettings {
  const validation = QuickChatSettingsSchema.safeParse(value);
  if (!validation.success) {
    return DEFAULT_QUICK_CHAT_SETTINGS;
  }
  return validation.data;
}
