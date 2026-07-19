import { defineRoutes } from "@pablozaiden/webapp/server";
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
import { GitService } from "../../core/git";
import { createLogger } from "@pablozaiden/webapp/server";
import type { FileContentResponse, PullRequestDestinationResponse } from "@/contracts";
import { errorResponse, internalErrorResponse, requireWorkspace } from "../helpers";
import { getPlanFilePath, getPlanningDirectoryPath, getStatusFilePath } from "../../lib/planning-files";

const log = createLogger("api:tasks");

export const tasksDataRoutes = defineRoutes({
  "/api/tasks/:id/diff": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read the git diff produced by a task.",
    /**
     * GET /api/tasks/:id/diff - Get git diff for a task's changes.
     *
     * Returns file diffs comparing the task's working branch to the original branch.
     * Each diff includes path, status, additions, deletions, and patch content.
     *
     * @returns Array of FileDiff objects
     */
    async GET(_req: Request, ctx): Promise<Response> {
      const task = await taskManager.getTask(ctx.params["id"]!);
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
          taskId: ctx.params["id"]!,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "diff_failed",
          message: "Failed to load the task diff",
          status: 500,
        });
      }
    },
  },

  "/api/tasks/:id/plan": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Read a task's planning document.",
    /**
     * GET /api/tasks/:id/plan - Get .clanky-planning/plan.md content.
     *
     * Reads the plan.md file from the task's .clanky-planning directory.
     * Returns the file content and whether the file exists.
     *
     * @returns FileContentResponse with content and exists flag
     */
    async GET(_req: Request, ctx): Promise<Response> {
      const task = await taskManager.getTask(ctx.params["id"]!);
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
    auth: "user",
    sameOrigin: "mutations",
    description: "Read a task's status tracking document.",
    /**
     * GET /api/tasks/:id/status-file - Get .clanky-planning/status.md content.
     *
     * Reads the status.md file from the task's .clanky-planning directory.
     * Returns the file content and whether the file exists.
     *
     * @returns FileContentResponse with content and exists flag
     */
    async GET(_req: Request, ctx): Promise<Response> {
      const task = await taskManager.getTask(ctx.params["id"]!);
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
    auth: "user",
    sameOrigin: "mutations",
    description: "Read pull request navigation details for a task.",
    /**
     * GET /api/tasks/:id/pull-request - Get PR navigation metadata for a task.
     *
     * Returns an existing PR URL, a PR creation URL, or a disabled state when
     * the workspace host cannot resolve a safe destination.
     */
    async GET(_req: Request, ctx): Promise<Response> {
      const destination = await taskManager.getPullRequestDestination(ctx.params["id"]!);
      if (!destination) {
        return errorResponse("not_found", "Task not found", 404);
      }

      const response: PullRequestDestinationResponse = destination;
      return Response.json(response);
    },
  },

  "/api/check-planning-dir": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Inspect a workspace's .clanky-planning files.",
    /**
     * GET /api/check-planning-dir - Check if .clanky-planning directory exists.
     *
     * Checks a workspace's directory for a .clanky-planning folder and lists its contents.
     * Useful for validating a project before creating a task.
     *
     * Query Parameters:
     * - workspaceId (required): Workspace ID
     *
     * Errors:
     * - 400: Missing workspaceId
     * - 404: Workspace not found
     * - 500: Failed to inspect the planning directory
     *
     * @returns Object with exists, hasFiles, files array, and optional warning
     */
    async GET(req: Request, _ctx): Promise<Response> {
      const url = new URL(req.url);
      const workspaceId = url.searchParams.get("workspaceId");

      if (!workspaceId) {
        return errorResponse("missing_workspace_id", "workspaceId query parameter is required", 400);
      }

      const workspace = await requireWorkspace(workspaceId);
      if (workspace instanceof Response) {
        return workspace;
      }
      const directory = workspace.directory;

      const planningDir = getPlanningDirectoryPath(directory);

      try {
        // Get mode-appropriate command executor
        const executor = await backendManager.getCommandExecutorAsync(workspace.id, directory);

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
          directory,
          workspaceId: workspace.id,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "check_failed",
          message: "Failed to check the planning directory",
          status: 500,
        });
      }
    },
  },
});
