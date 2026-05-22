/**
 * Tasks data routes (diff, plan, status-file, check-planning-dir).
 *
 * Provides read access to task data and files:
 * - GET /api/tasks/:id/diff - Get git diff for task changes
 * - GET /api/tasks/:id/plan - Get .clanky-planning/plan.md content
 * - GET /api/tasks/:id/status-file - Get .clanky-planning/status.md content
 * - GET /api/tasks/:id/pull-request - Get PR navigation metadata for pushed tasks
 * - GET /api/check-planning-dir - Check if .clanky-planning directory exists
 */

import { getTaskWorkingDirectory, taskManager } from "../../core/task-manager";
import { backendManager } from "../../core/backend-manager";
import { GitService } from "../../core/git-service";
import { createLogger } from "../../core/logger";
import type { FileContentResponse, PullRequestDestinationResponse } from "../../types/api";
import { errorResponse, normalizeDirectoryPath, resolveWorkspaceForDirectory } from "../helpers";
import { getPlanFilePath, getPlanningDirectoryPath, getStatusFilePath } from "../../lib/planning-files";

const log = createLogger("api:tasks");

export const tasksDataRoutes = {
  "/api/tasks/:id/diff": {
    /**
     * GET /api/tasks/:id/diff - Get git diff for a task's changes.
     *
     * Returns file diffs comparing the task's working branch to the original branch.
     * Each diff includes path, status, additions, deletions, and patch content.
     *
     * @returns Array of FileDiff objects
     */
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      const task = await taskManager.getTask(req.params.id);
      if (!task) {
        return errorResponse("not_found", "Task not found", 404);
      }

      if (!task.state.git) {
        return errorResponse("no_git_branch", "No git branch was created for this task", 400);
      }

      try {
        const workDir = getTaskWorkingDirectory(task);
        if (!workDir) {
          return errorResponse("no_worktree", "Task is configured to use a worktree, but no worktree path is available.", 400);
        }
        const executor = await backendManager.getCommandExecutorAsync(task.config.workspaceId, workDir);
        const git = GitService.withExecutor(executor);

        const diffs = await git.getDiffWithContent(
          workDir,
          task.state.git.originalBranch,
        );
        return Response.json(diffs);
      } catch (error) {
        log.error("Failed to get task diff", {
          taskId: req.params.id,
          error: String(error),
        });
        return errorResponse("diff_failed", String(error), 500);
      }
    },
  },

  "/api/tasks/:id/plan": {
    /**
     * GET /api/tasks/:id/plan - Get .clanky-planning/plan.md content.
     *
     * Reads the plan.md file from the task's .clanky-planning directory.
     * Returns the file content and whether the file exists.
     *
     * @returns FileContentResponse with content and exists flag
     */
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      const task = await taskManager.getTask(req.params.id);
      if (!task) {
        return errorResponse("not_found", "Task not found", 404);
      }

      const workDir = getTaskWorkingDirectory(task);
      if (!workDir) {
        return errorResponse("no_worktree", "Task is configured to use a worktree, but no worktree path is available.", 400);
      }

      const executor = await backendManager.getCommandExecutorAsync(task.config.workspaceId, workDir);
      const planPath = getPlanFilePath(workDir);

      const response: FileContentResponse = {
        content: "",
        exists: false,
      };

      const content = await executor.readFile(planPath);
      if (content !== null) {
        response.content = content;
        response.exists = true;
      }

      return Response.json(response);
    },
  },

  "/api/tasks/:id/status-file": {
    /**
     * GET /api/tasks/:id/status-file - Get .clanky-planning/status.md content.
     *
     * Reads the status.md file from the task's .clanky-planning directory.
     * Returns the file content and whether the file exists.
     *
     * @returns FileContentResponse with content and exists flag
     */
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      const task = await taskManager.getTask(req.params.id);
      if (!task) {
        return errorResponse("not_found", "Task not found", 404);
      }

      const workDir = getTaskWorkingDirectory(task);
      if (!workDir) {
        return errorResponse("no_worktree", "Task is configured to use a worktree, but no worktree path is available.", 400);
      }

      const executor = await backendManager.getCommandExecutorAsync(task.config.workspaceId, workDir);
      const statusPath = getStatusFilePath(workDir);

      const response: FileContentResponse = {
        content: "",
        exists: false,
      };

      const content = await executor.readFile(statusPath);
      if (content !== null) {
        response.content = content;
        response.exists = true;
      }

      return Response.json(response);
    },
  },

  "/api/tasks/:id/pull-request": {
    /**
     * GET /api/tasks/:id/pull-request - Get PR navigation metadata for a task.
     *
     * Returns an existing PR URL, a PR creation URL, or a disabled state when
     * the workspace host cannot resolve a safe destination.
     */
    async GET(req: Request & { params: { id: string } }): Promise<Response> {
      const destination = await taskManager.getPullRequestDestination(req.params.id);
      if (!destination) {
        return errorResponse("not_found", "Task not found", 404);
      }

      const response: PullRequestDestinationResponse = destination;
      return Response.json(response);
    },
  },

  "/api/check-planning-dir": {
    /**
     * GET /api/check-planning-dir - Check if .clanky-planning directory exists.
     *
     * Checks if a directory has a .clanky-planning folder and lists its contents.
     * Useful for validating a project before creating a task. When multiple
     * workspaces share the same directory path across different server targets,
     * callers should pass `workspaceId` to disambiguate the lookup.
     *
     * Query Parameters:
     * - directory (required): Absolute path to check
     * - workspaceId (optional): Workspace ID used to disambiguate shared directories
     *
     * Errors:
     * - 400: Missing directory parameter or workspaceId/directory mismatch
     * - 404: Workspace not found
     * - 409: Multiple workspaces use this directory and workspaceId was not provided
     * - 500: Failed to inspect the planning directory
     *
     * @returns Object with exists, hasFiles, files array, and optional warning
     */
    async GET(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const directory = url.searchParams.get("directory");
      const workspaceId = url.searchParams.get("workspaceId");

      if (!directory) {
        return errorResponse("invalid_request", "directory query parameter is required", 400);
      }

      const normalizedDirectory = normalizeDirectoryPath(directory);
      const workspace = await resolveWorkspaceForDirectory(normalizedDirectory, workspaceId);
      if (workspace instanceof Response) {
        return workspace;
      }

      const planningDir = getPlanningDirectoryPath(normalizedDirectory);

      try {
        // Get mode-appropriate command executor
        const executor = await backendManager.getCommandExecutorAsync(workspace.id, normalizedDirectory);

        // Check if directory exists
        const exists = await executor.directoryExists(planningDir);

        if (!exists) {
          return Response.json({
            exists: false,
            hasFiles: false,
            files: [],
          });
        }

        // List files in the directory
        const files = await executor.listDirectory(planningDir);

        const visibleFiles = files.filter((file) => file !== ".gitkeep");

        if (visibleFiles.length === 0) {
          return Response.json({
            exists: true,
            hasFiles: false,
            files: [],
          });
        }

        return Response.json({
          exists: true,
          hasFiles: true,
          files: visibleFiles,
        });
      } catch (error) {
        log.error("Failed to inspect planning directory", {
          directory: normalizedDirectory,
          workspaceId: workspace.id,
          error: String(error),
        });
        return errorResponse("check_failed", String(error), 500);
      }
    },
  },
};
