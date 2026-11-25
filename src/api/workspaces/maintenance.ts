import { defineRoutes } from "@/platform/server";
import { workspaceOperation } from "../workspace-delegation";
/**
 * Workspace maintenance routes for actions like pulling the default branch.
 */

import { backendManager } from "../../core/backend-manager";
import { GitCommandError, GitService } from "../../core/git";
import { createLogger } from "@pablozaiden/webapp/server";
import { errorResponse, internalErrorResponse, requireGitBackedWorkspace, requireWorkspace, successResponse } from "../helpers";
import { RepositoryQuerySchema } from "../route-schemas";
import { resolveRepositoryDefaultBranch, resolveWorkspaceRepository } from "../../core/repository-group-service";
import { isDomainError } from "../../domain/domain-error";

const log = createLogger("api:workspace-maintenance");

export const workspaceMaintenanceRoutes = defineRoutes({
  "/api/workspaces/:id/pull-latest-changes": {
    delegation: workspaceOperation("workspace"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Pull the workspace's default branch and refresh remote-tracking branches.",
    operations: {
      POST: { requestSchema: undefined, querySchema: RepositoryQuerySchema, automation: { policy: "confirm", reason: "Changes the workspace repository from its remote." } },
    },
    async POST(req: Request, ctx): Promise<Response> {
      const workspaceResult = await requireWorkspace(ctx.params["id"]!);
      if (workspaceResult instanceof Response) {
        return workspaceResult;
      }
      const query = RepositoryQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
      if (!query.success) return errorResponse("validation_error", "Choose a repository in the workspace.", 400);
      const multiGit = workspaceResult.workspaceType === "multi-git";
      if (multiGit !== Boolean(query.data.repository)) return errorResponse("repository_target_required", "Choose exactly one repository for a multirepository pull.", 400);
      const gitWorkspace = multiGit ? workspaceResult : requireGitBackedWorkspace(workspaceResult);
      if (gitWorkspace instanceof Response) {
        return gitWorkspace;
      }

      try {
        const executor = await backendManager.getCommandExecutorAsync(
          gitWorkspace.id,
          gitWorkspace.directory,
        );
        const directory = query.data.repository
          ? await resolveWorkspaceRepository(executor, gitWorkspace.directory, query.data.repository)
          : gitWorkspace.directory;
        const git = GitService.withExecutor(executor);

        if (!(await git.isGitRepo(directory))) {
          return errorResponse("not_git_repo", "Workspace directory must be a git repository", 400);
        }

        const { branch: defaultBranch, remote } = multiGit
          ? await resolveRepositoryDefaultBranch(executor, directory, true)
          : { branch: await git.getDefaultBranch(directory), remote: "origin" };
        const currentBranch = await git.getCurrentBranch(directory);

        if (currentBranch !== defaultBranch) {
          return errorResponse(
            "branch_mismatch",
            `Workspace is currently on "${currentBranch}". Switch to the default branch "${defaultBranch}" before pulling latest changes.`,
            409,
          );
        }

        if (await git.hasUncommittedChanges(directory)) {
          return errorResponse(
            "uncommitted_changes",
            `Workspace has uncommitted changes on "${defaultBranch}". Commit or stash them before pulling latest changes.`,
            409,
          );
        }

        if (!remote || !(await git.hasRemote(directory, remote))) {
          return errorResponse(
            "no_remote",
            multiGit ? "No default remote is configured for the selected repository." : "Workspace has no git remote configured. Add an origin remote before pulling latest changes.",
            409,
          );
        }

        await git.pullBranch(directory, defaultBranch, remote);

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
        if (isDomainError(error) && error.code === "repository_group_unavailable") {
          return errorResponse(error.code, error.message, 409);
        }
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
