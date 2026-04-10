/**
 * Workspace maintenance routes for actions like pulling the default branch.
 */

import { backendManager } from "../../core/backend-manager";
import { GitCommandError, GitService } from "../../core/git";
import { createLogger } from "../../core/logger";
import { errorResponse, requireWorkspace, successResponse } from "../helpers";

const log = createLogger("api:workspace-maintenance");

export const workspaceMaintenanceRoutes = {
  "/api/workspaces/:id/pull-latest-changes": {
    async POST(req: Request & { params: { id: string } }): Promise<Response> {
      const workspaceResult = await requireWorkspace(req.params.id);
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }

      try {
        const executor = await backendManager.getCommandExecutorAsync(
          workspaceResult.id,
          workspaceResult.directory,
        );
        const git = GitService.withExecutor(executor);

        if (!(await git.isGitRepo(workspaceResult.directory))) {
          return errorResponse("not_git_repo", "Workspace directory must be a git repository", 400);
        }

        const defaultBranch = await git.getDefaultBranch(workspaceResult.directory);
        const currentBranch = await git.getCurrentBranch(workspaceResult.directory);

        if (currentBranch !== defaultBranch) {
          return errorResponse(
            "branch_mismatch",
            `Workspace is currently on "${currentBranch}". Switch to the default branch "${defaultBranch}" before pulling latest changes.`,
            409,
          );
        }

        if (await git.hasUncommittedChanges(workspaceResult.directory)) {
          return errorResponse(
            "uncommitted_changes",
            `Workspace has uncommitted changes on "${defaultBranch}". Commit or stash them before pulling latest changes.`,
            409,
          );
        }

        await git.pullBranch(workspaceResult.directory, defaultBranch);

        log.info("Pulled latest changes for workspace", {
          workspaceId: workspaceResult.id,
          directory: workspaceResult.directory,
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
            workspaceId: workspaceResult.id,
            directory: workspaceResult.directory,
            error: String(error),
          });
          return errorResponse("git_pull_failed", error.message, 409);
        }

        log.error("Workspace pull latest action failed unexpectedly", {
          workspaceId: workspaceResult.id,
          directory: workspaceResult.directory,
          error: String(error),
        });
        return errorResponse("git_pull_failed", String(error), 500);
      }
    },
  },
};
