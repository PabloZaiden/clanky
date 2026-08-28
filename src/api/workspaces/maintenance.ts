import { defineRoutes } from "@pablozaiden/webapp/server";
/**
 * Workspace maintenance routes for actions like pulling the default branch.
 */

import { backendManager } from "../../core/backend-manager";
import { GitCommandError, GitService } from "../../core/git";
import { createLogger } from "@pablozaiden/webapp/server";
import { errorResponse, internalErrorResponse, requireGitBackedWorkspace, requireWorkspace, successResponse } from "../helpers";

const log = createLogger("api:workspace-maintenance");

export const workspaceMaintenanceRoutes = defineRoutes({
  "/api/workspaces/:id/pull-latest-changes": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Pull the latest changes for a workspace's default branch.",
    async POST(_req: Request, ctx): Promise<Response> {
      const workspaceResult = await requireWorkspace(ctx.params["id"]!);
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }
      const gitWorkspace = requireGitBackedWorkspace(workspaceResult);
      if (gitWorkspace instanceof Response) {
        return gitWorkspace;
      }

      try {
        const executor = await backendManager.getCommandExecutorAsync(
          gitWorkspace.id,
          gitWorkspace.directory,
        );
        const git = GitService.withExecutor(executor);

        if (!(await git.isGitRepo(gitWorkspace.directory))) {
          return errorResponse("not_git_repo", "Workspace directory must be a git repository", 400);
        }

        const defaultBranch = await git.getDefaultBranch(gitWorkspace.directory);
        const currentBranch = await git.getCurrentBranch(gitWorkspace.directory);

        if (currentBranch !== defaultBranch) {
          return errorResponse(
            "branch_mismatch",
            `Workspace is currently on "${currentBranch}". Switch to the default branch "${defaultBranch}" before pulling latest changes.`,
            409,
          );
        }

        if (await git.hasUncommittedChanges(gitWorkspace.directory)) {
          return errorResponse(
            "uncommitted_changes",
            `Workspace has uncommitted changes on "${defaultBranch}". Commit or stash them before pulling latest changes.`,
            409,
          );
        }

        if (!(await git.hasRemote(gitWorkspace.directory))) {
          return errorResponse(
            "no_remote",
            "Workspace has no git remote configured. Add an origin remote before pulling latest changes.",
            409,
          );
        }

        await git.pullBranch(gitWorkspace.directory, defaultBranch);

        log.info("Pulled latest changes for workspace", {
          workspaceId: gitWorkspace.id,
          directory: gitWorkspace.directory,
          defaultBranch,
        });

        return successResponse({
          workspaceId: workspaceResult.id,
          defaultBranch,
          currentBranch,
        });
      } catch (error) {
        if (error instanceof GitCommandError) {
          log.warn("Workspace pull latest action failed", {
            workspaceId: gitWorkspace.id,
            directory: gitWorkspace.directory,
            command: error.command,
            exitCode: error.exitCode,
            gitStderr: error.gitStderr,
            error: error.message,
          });
          return errorResponse(
            "git_pull_failed",
            "Unable to pull the latest changes from the remote repository.",
            409,
          );
        }

        log.error("Workspace pull latest action failed unexpectedly", {
          workspaceId: gitWorkspace.id,
          directory: gitWorkspace.directory,
          error: String(error),
        });
        return internalErrorResponse(error, {
          error: "git_pull_failed",
          message: "Failed to pull the latest workspace changes",
          status: 500,
        });
      }
    },
  },
});
