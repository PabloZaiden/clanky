/**
 * AGENTS.md optimization API endpoints.
 *
 * Provides endpoints for reading, previewing, and applying
 * Clanky optimization to a workspace's AGENTS.md file.
 *
 * Endpoints:
 * - GET  /api/workspaces/:id/agents-md          - Read current AGENTS.md
 * - POST /api/workspaces/:id/agents-md/preview  - Preview optimization changes
 * - POST /api/workspaces/:id/agents-md/optimize - Apply optimization
 *
 * @module api/agents-md
 */

import { getWorkspace } from "../persistence/workspaces";
import { backendManager } from "../core/backend-manager";
import { createLogger } from "../core/logger";
import { errorResponse } from "./helpers";
import {
  analyzeAgentsMd,
  previewOptimization,
  optimizeContent,
} from "../core/agents-md-optimizer";
import { join } from "path";

const log = createLogger("api:agents-md");

/**
 * Get the AGENTS.md file path for a workspace directory.
 */
function getAgentsMdPath(directory: string): string {
  return join(directory, "AGENTS.md");
}

/**
 * AGENTS.md optimization API routes.
 */
export const agentsMdRoutes = {
  /**
   * GET/POST dispatcher for /api/workspaces/:id/agents-md
   *
   * GET: Read the current AGENTS.md content and its optimization status.
   */
  "/api/workspaces/:id/agents-md": async (req: Request & { params: { id: string } }) => {
    const { id } = req.params;

    if (req.method !== "GET") {
      return errorResponse("method_not_allowed", "Method not allowed", 405);
    }

    log.debug("GET /api/workspaces/:id/agents-md", { workspaceId: id });

    try {
      const workspace = await getWorkspace(id);
      if (!workspace) {
        return errorResponse("workspace_not_found", "Workspace not found", 404);
      }

      const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
      const agentsMdPath = getAgentsMdPath(workspace.directory);
      const fileExists = await executor.fileExists(agentsMdPath);
      const content = fileExists ? await executor.readFile(agentsMdPath) : null;

      // If the file exists but we couldn't read it, treat as a server error
      if (fileExists && content === null) {
        log.error("AGENTS.md exists but could not be read", { workspaceId: id });
        return errorResponse("read_failed", "AGENTS.md exists but could not be read (possible permissions or transient error)", 500);
      }

      const analysis = analyzeAgentsMd(content);

      return Response.json({
        content: content ?? "",
        fileExists,
        analysis,
      });
    } catch (error) {
      log.error("Failed to read AGENTS.md", { workspaceId: id, error: String(error) });
      return errorResponse("read_failed", `Failed to read AGENTS.md: ${String(error)}`, 500);
    }
  },

  /**
   * POST /api/workspaces/:id/agents-md/preview
   *
   * Returns a preview of what the optimized AGENTS.md would look like.
   */
  "/api/workspaces/:id/agents-md/preview": async (req: Request & { params: { id: string } }) => {
    const { id } = req.params;

    if (req.method !== "POST") {
      return errorResponse("method_not_allowed", "Method not allowed", 405);
    }

    log.debug("POST /api/workspaces/:id/agents-md/preview", { workspaceId: id });

    try {
      const workspace = await getWorkspace(id);
      if (!workspace) {
        return errorResponse("workspace_not_found", "Workspace not found", 404);
      }

      const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
      const agentsMdPath = getAgentsMdPath(workspace.directory);
      const fileExists = await executor.fileExists(agentsMdPath);
      const content = fileExists ? await executor.readFile(agentsMdPath) : null;

      // If the file exists but we couldn't read it, treat as a server error
      if (fileExists && content === null) {
        log.error("AGENTS.md exists but could not be read for preview", { workspaceId: id });
        return errorResponse("read_failed", "AGENTS.md exists but could not be read (possible permissions or transient error)", 500);
      }

      const preview = previewOptimization(content, fileExists);

      return Response.json(preview);
    } catch (error) {
      log.error("Failed to preview AGENTS.md optimization", { workspaceId: id, error: String(error) });
      return errorResponse("preview_failed", `Failed to preview optimization: ${String(error)}`, 500);
    }
  },

  /**
   * POST /api/workspaces/:id/agents-md/optimize
   *
   * Applies the Clanky optimization to the workspace's AGENTS.md.
   * Creates the file if it doesn't exist, appends section if missing,
   * or updates the section if an older version is present.
   */
  "/api/workspaces/:id/agents-md/optimize": async (req: Request & { params: { id: string } }) => {
    const { id } = req.params;

    if (req.method !== "POST") {
      return errorResponse("method_not_allowed", "Method not allowed", 405);
    }

    log.debug("POST /api/workspaces/:id/agents-md/optimize", { workspaceId: id });

    try {
      const workspace = await getWorkspace(id);
      if (!workspace) {
        return errorResponse("workspace_not_found", "Workspace not found", 404);
      }

      const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
      const agentsMdPath = getAgentsMdPath(workspace.directory);
      const fileExists = await executor.fileExists(agentsMdPath);
      const currentContent = fileExists ? await executor.readFile(agentsMdPath) : null;

      // If the file exists but we couldn't read it, treat as a server error
      if (fileExists && currentContent === null) {
        log.error("AGENTS.md exists but could not be read for optimization", { workspaceId: id });
        return errorResponse("read_failed", "AGENTS.md exists but could not be read (possible permissions or transient error)", 500);
      }

      const analysis = analyzeAgentsMd(currentContent);

      // Already optimized at current version — no-op
      if (analysis.isOptimized && !analysis.updateAvailable) {
        log.info("AGENTS.md already optimized at current version", { workspaceId: id });
        return Response.json({
          success: true,
          alreadyOptimized: true,
          content: currentContent ?? "",
          analysis,
        });
      }

      // Generate optimized content
      const optimizedContent = optimizeContent(currentContent, analysis);

      // Write the optimized content
      const writeSuccess = await executor.writeFile(agentsMdPath, optimizedContent);
      if (!writeSuccess) {
        log.error("Failed to write optimized AGENTS.md", { workspaceId: id });
        return errorResponse("write_failed", "Failed to write AGENTS.md to the workspace", 500);
      }

      log.info("AGENTS.md optimized successfully", {
        workspaceId: id,
        wasUpdate: analysis.isOptimized,
        previousVersion: analysis.currentVersion,
      });

      return Response.json({
        success: true,
        alreadyOptimized: false,
        content: optimizedContent,
        analysis: analyzeAgentsMd(optimizedContent),
      });
    } catch (error) {
      log.error("Failed to optimize AGENTS.md", { workspaceId: id, error: String(error) });
      return errorResponse("optimize_failed", `Failed to optimize AGENTS.md: ${String(error)}`, 500);
    }
  },
};
