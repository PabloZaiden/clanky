/**
 * User preferences API routes.
 *
 * - GET/PUT /api/preferences/last-model
 * - GET/PUT /api/preferences/last-directory
 * - GET/PUT /api/preferences/markdown-rendering
 * - GET/PUT /api/preferences/file-explorer-full-tree
 * - GET/PUT /api/preferences/log-level
 * - GET/PUT /api/preferences/dashboard-view-mode
 * - GET/PUT /api/preferences/theme
 *
 * @module api/models/preferences-routes
 */

import {
  getLastModel,
  getLastCheapModel,
  setLastModel,
  setLastCheapModel,
  getLastDirectory,
  setLastDirectory,
  getMarkdownRenderingEnabled,
  setMarkdownRenderingEnabled,
  getFileExplorerFullTreeEnabled,
  setFileExplorerFullTreeEnabled,
  getLogLevelPreference,
  setLogLevelPreference,
  DEFAULT_LOG_LEVEL,
  getDashboardViewMode,
  setDashboardViewMode,
  getThemePreference,
  setThemePreference,
  getQuickChatSettings,
  setQuickChatSettings,
} from "../../persistence/preferences";
import { getWorkspace } from "../../persistence/workspaces";
import {
  createLogger,
  setLogLevel as setBackendLogLevel,
  type LogLevelName,
  VALID_LOG_LEVELS,
  isLogLevelFromEnv,
} from "../../core/logger";
import { parseAndValidate } from "../validation";
import { errorResponse } from "../helpers";
import {
  SetLastModelRequestSchema,
  SetLastCheapModelRequestSchema,
  SetLastDirectoryRequestSchema,
  SetMarkdownRenderingRequestSchema,
  SetFileExplorerFullTreeRequestSchema,
  SetLogLevelRequestSchema,
  SetDashboardViewModeRequestSchema,
  SetThemePreferenceRequestSchema,
  SetQuickChatSettingsRequestSchema,
} from "../../types/schemas";

const log = createLogger("api:preferences");

function logPreferenceSaveFailure(preference: string, error: unknown): void {
  log.error("Failed to save preference", {
    preference,
    error: String(error),
  });
}

/**
 * Preferences API routes.
 */
export const preferencesRoutes = {
  "/api/preferences/last-model": {
    /**
     * GET /api/preferences/last-model - Get the last used model.
     *
     * @returns ModelConfig object or null if none set
     */
    async GET(): Promise<Response> {
      const lastModel = await getLastModel();
      return Response.json(lastModel ?? null);
    },

    /**
     * PUT /api/preferences/last-model - Set the last used model.
     *
     * Request Body:
     * - providerID (required): Provider ID (e.g., "anthropic")
     * - modelID (required): Model ID (e.g., "claude-sonnet-4-20250514")
     * - variant (optional): Model variant (e.g., "thinking")
     *
     * @returns Success response
     */
    async PUT(req: Request): Promise<Response> {
      const result = await parseAndValidate(SetLastModelRequestSchema, req);
      if (!result.success) {
        return result.response;
      }

      try {
        await setLastModel({
          providerID: result.data.providerID,
          modelID: result.data.modelID,
          variant: result.data.variant,
        });

        return Response.json({ success: true });
      } catch (error) {
        logPreferenceSaveFailure("last-model", error);
        return errorResponse("save_failed", String(error), 500);
      }
    },
  },

  "/api/preferences/last-cheap-model": {
    /**
     * GET /api/preferences/last-cheap-model - Get the last used cheap helper-model selection.
     */
    async GET(): Promise<Response> {
      const lastCheapModel = await getLastCheapModel();
      return Response.json(lastCheapModel ?? null);
    },

    /**
     * PUT /api/preferences/last-cheap-model - Set the last used cheap helper-model selection.
     */
    async PUT(req: Request): Promise<Response> {
      const result = await parseAndValidate(SetLastCheapModelRequestSchema, req);
      if (!result.success) {
        return result.response;
      }

      try {
        await setLastCheapModel(result.data);
        return Response.json({ success: true });
      } catch (error) {
        logPreferenceSaveFailure("last-cheap-model", error);
        return errorResponse("save_failed", String(error), 500);
      }
    },
  },

  "/api/preferences/last-directory": {
    /**
     * GET /api/preferences/last-directory - Get the last used working directory.
     *
     * @returns Directory path string or null if none set
     */
    async GET(): Promise<Response> {
      const lastDirectory = await getLastDirectory();
      return Response.json(lastDirectory ?? null);
    },

    /**
     * PUT /api/preferences/last-directory - Set the last used working directory.
     *
     * Request Body:
     * - directory (required): Absolute path to the directory
     *
     * @returns Success response
     */
    async PUT(req: Request): Promise<Response> {
      const result = await parseAndValidate(SetLastDirectoryRequestSchema, req);
      if (!result.success) {
        return result.response;
      }

      try {
        await setLastDirectory(result.data.directory);

        return Response.json({ success: true });
      } catch (error) {
        logPreferenceSaveFailure("last-directory", error);
        return errorResponse("save_failed", String(error), 500);
      }
    },
  },

  "/api/preferences/markdown-rendering": {
    /**
     * GET /api/preferences/markdown-rendering - Get markdown rendering preference.
     *
     * @returns Boolean indicating if markdown rendering is enabled
     */
    async GET(): Promise<Response> {
      const enabled = await getMarkdownRenderingEnabled();
      return Response.json({ enabled });
    },

    /**
     * PUT /api/preferences/markdown-rendering - Set markdown rendering preference.
     *
     * Request Body:
     * - enabled (required): Boolean - true to enable, false to disable
     *
     * @returns Success response
     */
    async PUT(req: Request): Promise<Response> {
      const result = await parseAndValidate(SetMarkdownRenderingRequestSchema, req);
      if (!result.success) {
        return result.response;
      }

      try {
        await setMarkdownRenderingEnabled(result.data.enabled);

        return Response.json({ success: true });
      } catch (error) {
        logPreferenceSaveFailure("markdown-rendering", error);
        return errorResponse("save_failed", String(error), 500);
      }
    },
  },

  "/api/preferences/file-explorer-full-tree": {
    /**
     * GET /api/preferences/file-explorer-full-tree - Get file explorer loading preference.
     *
     * @returns Boolean indicating if the explorer should load the full tree at once
     */
    async GET(): Promise<Response> {
      const enabled = await getFileExplorerFullTreeEnabled();
      return Response.json({ enabled });
    },

    /**
     * PUT /api/preferences/file-explorer-full-tree - Set file explorer loading preference.
     *
     * Request Body:
     * - enabled (required): Boolean - true to load the full tree at once, false for lazy loading
     *
     * @returns Success response
     */
    async PUT(req: Request): Promise<Response> {
      const result = await parseAndValidate(SetFileExplorerFullTreeRequestSchema, req);
      if (!result.success) {
        return result.response;
      }

      try {
        await setFileExplorerFullTreeEnabled(result.data.enabled);

        return Response.json({ success: true });
      } catch (error) {
        logPreferenceSaveFailure("file-explorer-full-tree", error);
        return errorResponse("save_failed", String(error), 500);
      }
    },
  },

  "/api/preferences/log-level": {
    /**
     * GET /api/preferences/log-level - Get log level preference.
     *
     * @returns Object with level, defaultLevel, availableLevels, and isFromEnv
     */
    async GET(): Promise<Response> {
      const level = await getLogLevelPreference();
      return Response.json({
        level,
        defaultLevel: DEFAULT_LOG_LEVEL,
        availableLevels: VALID_LOG_LEVELS,
        isFromEnv: isLogLevelFromEnv(),
      });
    },

    /**
     * PUT /api/preferences/log-level - Set log level preference.
     *
     * Request Body:
     * - level (required): Log level name string
     *
     * @returns Success response
     */
    async PUT(req: Request): Promise<Response> {
      const result = await parseAndValidate(SetLogLevelRequestSchema, req);
      if (!result.success) {
        return result.response;
      }

      const level = result.data.level;

      if (!VALID_LOG_LEVELS.includes(level as LogLevelName)) {
        return errorResponse("invalid_level", `Invalid log level: ${level}. Valid levels are: ${VALID_LOG_LEVELS.join(", ")}`);
      }

      try {
        // Save to preferences
        await setLogLevelPreference(level as LogLevelName);

        // Also update the backend logger in real-time
        setBackendLogLevel(level as LogLevelName);

        return Response.json({ success: true, level });
      } catch (error) {
        logPreferenceSaveFailure("log-level", error);
        return errorResponse("save_failed", String(error), 500);
      }
    },
  },

  "/api/preferences/dashboard-view-mode": {
    /**
     * GET /api/preferences/dashboard-view-mode - Get dashboard view mode preference.
     *
     * @returns Object with mode property
     */
    async GET(): Promise<Response> {
      const mode = await getDashboardViewMode();
      return Response.json({ mode });
    },

    /**
     * PUT /api/preferences/dashboard-view-mode - Set dashboard view mode preference.
     *
     * Request Body:
     * - mode (required): "rows" or "cards"
     *
     * @returns Success response
     */
    async PUT(req: Request): Promise<Response> {
      const result = await parseAndValidate(SetDashboardViewModeRequestSchema, req);
      if (!result.success) {
        return result.response;
      }

      try {
        await setDashboardViewMode(result.data.mode);
        return Response.json({ success: true, mode: result.data.mode });
      } catch (error) {
        logPreferenceSaveFailure("dashboard-view-mode", error);
        return errorResponse("save_failed", String(error), 500);
      }
    },
  },

  "/api/preferences/theme": {
    /**
     * GET /api/preferences/theme - Get theme preference.
     *
     * @returns Object with theme property
     */
    async GET(): Promise<Response> {
      const theme = await getThemePreference();
      return Response.json({ theme });
    },

    /**
     * PUT /api/preferences/theme - Set theme preference.
     *
     * Request Body:
     * - theme (required): "light", "dark", or "system"
     *
     * @returns Success response
     */
    async PUT(req: Request): Promise<Response> {
      const result = await parseAndValidate(SetThemePreferenceRequestSchema, req);
      if (!result.success) {
        return result.response;
      }

      try {
        await setThemePreference(result.data.theme);
        return Response.json({ success: true, theme: result.data.theme });
      } catch (error) {
        logPreferenceSaveFailure("theme", error);
        return errorResponse("save_failed", String(error), 500);
      }
    },
  },

  "/api/preferences/quick-chat": {
    async GET(): Promise<Response> {
      const settings = await getQuickChatSettings();
      return Response.json(settings);
    },

    async PUT(req: Request): Promise<Response> {
      const result = await parseAndValidate(SetQuickChatSettingsRequestSchema, req);
      if (!result.success) {
        return result.response;
      }

      try {
        const settings = {
          workspaceId: result.data.workspaceId,
          model: result.data.model,
          useWorktree: result.data.useWorktree,
        };
        if (settings.workspaceId) {
          const workspace = await getWorkspace(settings.workspaceId);
          if (!workspace) {
            return errorResponse(
              "workspace_not_found",
              "Quick chat workspace does not exist",
              404,
            );
          }
        }
        await setQuickChatSettings(settings);
        return Response.json({ success: true, settings });
      } catch (error) {
        logPreferenceSaveFailure("quick-chat", error);
        return errorResponse("save_failed", String(error), 500);
      }
    },
  },
};
