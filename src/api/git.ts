import { defineRoutes } from "@/platform/server";
import { workspaceOperation } from "./workspace-delegation";
import { GitRemoteStatusQuerySchema, WorkspaceGitQuerySchema, WorkspaceQuerySchema } from "./route-schemas";
/**
 * Git API endpoints for Clanky.
 * 
 * This module provides git-related endpoints for querying repository information.
 * All git operations use the deterministic CommandExecutor abstraction
 * (local or Mesh execution hosts).
 * 
 * Endpoints:
 * - GET /api/git/branches - List local and cached remote-tracking branches
 * - GET /api/git/default-branch - Detect the repository default branch
 * - GET /api/git/remote-status - Check whether a remote exists
 * - GET /api/git/github-repository-url - Resolve the GitHub repository URL
 * - GET /api/git/github-issues - List open GitHub issues
 * 
 * @module api/git
 */

import { backendManager } from "../core/backend-manager";
import { GitCommandError, GitService } from "../core/git";
import { listOpenGitHubIssues } from "../core/github-issues";
import { normalizeGitHubRepositoryUrl } from "../lib/github-repository-url";
import type { Workspace } from "@/shared";
import type {
  BranchInfo,
  GitHubIssuesResponse,
  GitHubRepositoryUrlResponse,
  GitRemoteStatusResponse,
} from "@/contracts";
import type { CommandExecutor } from "../core/command-executor";
import { createLogger } from "@pablozaiden/webapp/server";
import { errorResponse, internalErrorResponse, requireGitBackedWorkspace, requireWorkspace } from "./helpers";
import { listWorkspaceRepositories, resolveRepositoryDefaultBranch, resolveWorkspaceRepository } from "../core/repository-group-service";
import { RepositoryNameSchema } from "@/contracts/schemas/repository-group";
import { isDomainError } from "../domain/domain-error";

const log = createLogger("api:git");

/**
 * Response for GET /api/git/branches endpoint.
 */
export interface BranchesResponse {
  /** Name of the currently checked out branch */
  currentBranch: string;
  /** Local branches and remote-tracking branches from the last fetch */
  branches: BranchInfo[];
}

/**
 * Response for GET /api/git/default-branch endpoint.
 */
export interface DefaultBranchResponse {
  /** The repository's default branch (e.g., "main", "master") */
  defaultBranch: string;
}

async function resolveGitHubRepositoryUrl(
  workspaceId: string,
  request: Request,
): Promise<string | null | Response> {
  const workspaceResult = await requireWorkspace(workspaceId);
  if (workspaceResult instanceof Response) {
    return workspaceResult;
  }
  if (workspaceResult.workspaceType === "multi-git") {
    const target = await validateGitRequest(request);
    if (target instanceof Response) return target;
    return await resolveGitHubRepositoryUrlForWorkspace(target.workspace, target.git, target.directory);
  }
  const gitWorkspace = requireGitBackedWorkspace(workspaceResult);
  if (gitWorkspace instanceof Response) {
    return gitWorkspace;
  }
  return await resolveGitHubRepositoryUrlForWorkspace(gitWorkspace);
}

async function resolveGitHubRepositoryUrlForWorkspace(
  workspace: Workspace,
  git?: GitService,
  directory = workspace.directory,
): Promise<string | null> {
  const persistedRepoUrl = workspace.workspaceType === "git" ? workspace.repoUrl?.trim() ?? "" : "";
  if (persistedRepoUrl) {
    return normalizeGitHubRepositoryUrl(persistedRepoUrl);
  }

  const gitService = git ?? GitService.withExecutor(await backendManager.getCommandExecutorAsync(workspace.id, directory));

  if (!(await gitService.isGitRepo(directory))) {
    return null;
  }

  try {
    const remoteUrl = await gitService.getRemoteUrl(directory, "origin");
    return normalizeGitHubRepositoryUrl(remoteUrl);
  } catch (error) {
    if (error instanceof GitCommandError) {
      log.info("GitHub repository URL unavailable from origin remote", {
        workspaceId: workspace.id,
        directory,
        command: error.command,
        exitCode: error.exitCode,
        gitStderr: error.gitStderr,
      });
      return null;
    }
    throw error;
  }
}

/** Validate a workspace git request and verify its repository. */
async function validateGitRequest(req: Request): Promise<
  { git: GitService; executor: CommandExecutor; directory: string; workspace: Workspace } | Response
> {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");

  if (!workspaceId) {
    log.debug("Missing workspaceId parameter");
    return errorResponse("missing_workspace_id", "workspaceId query parameter is required");
  }

  const workspace = await requireWorkspace(workspaceId);
  if (workspace instanceof Response) {
    return workspace;
  }
  if (workspace.workspaceType === "multi-git") {
    const repository = RepositoryNameSchema.safeParse(url.searchParams.get("repository"));
    if (!repository.success) return errorResponse("repository_required", "Choose a repository in this workspace", 400);
    const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
    try {
      const directory = await resolveWorkspaceRepository(executor, workspace.directory, repository.data);
      return { git: GitService.withExecutor(executor), executor, directory, workspace };
    } catch (error) {
      if (isDomainError(error) && error.code === "repository_group_unavailable") {
        return errorResponse(error.code, error.message, 409);
      }
      throw error;
    }
  }
  if (url.searchParams.has("repository")) return errorResponse("validation_error", "This workspace does not have multiple repositories", 400);
  const gitWorkspace = requireGitBackedWorkspace(workspace);
  if (gitWorkspace instanceof Response) {
    return gitWorkspace;
  }

  const executor = await backendManager.getCommandExecutorAsync(gitWorkspace.id, gitWorkspace.directory);
  const git = GitService.withExecutor(executor);
  const directory = gitWorkspace.directory;
  if (!await git.isGitRepo(directory)) {
    log.debug("Workspace directory is not a git repository", {
      workspaceId: workspace.id,
      directory,
    });
    return errorResponse("not_git_repo", "Workspace directory is not a git repository");
  }
  return { git, executor, directory, workspace: gitWorkspace };
}

/**
 * Git API routes.
 * 
 * Provides endpoints for git repository and GitHub information:
 * - GET /api/git/branches - List local and cached remote-tracking branches
 * - GET /api/git/default-branch - Detect the default branch
 * - GET /api/git/remote-status - Check for a configured remote
 * - GET /api/git/github-repository-url - Resolve the repository URL
 * - GET /api/git/github-issues - List open issues
 */
export const gitRoutes = defineRoutes({
  "/api/git/repositories": {
    delegation: workspaceOperation("workspace"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Discover the direct Git repositories and available base branches in a multirepository workspace.",
    operations: {
      GET: { requestSchema: undefined, querySchema: WorkspaceQuerySchema, automation: { policy: "read" } },
    },
    async GET(req) {
      const query = WorkspaceQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
      if (!query.success) return errorResponse("validation_error", "Choose a workspace", 400);
      const workspace = await requireWorkspace(query.data.workspaceId);
      if (workspace instanceof Response) return workspace;
      if (workspace.workspaceType !== "multi-git") {
        return errorResponse("repository_group_unavailable", "This workspace is not multirepository", 409);
      }
      const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
      try {
        return Response.json(await listWorkspaceRepositories(executor, workspace.directory));
      } catch (error) {
        if (isDomainError(error) && error.code === "repository_group_unavailable") {
          return errorResponse(error.code, error.message, 409);
        }
        log.error("Failed to discover workspace repositories", { workspaceId: workspace.id, error: String(error) });
        return internalErrorResponse(error, { error: "git_error", message: "Failed to discover workspace repositories", status: 500 });
      }
    },
  },
  /**
   * GET /api/git/branches - Get local and cached remote-tracking branches.
   * 
   * Returns local branches and remote-tracking branches from the last fetch.
   * Identifies the currently checked out local branch.
   * Validates that the directory is a git repository.
   * 
   * Query Parameters:
   * - workspaceId (required): Workspace ID
   * 
   * Errors:
   * - 400: Missing workspaceId or not a git repo
   * - 404: Workspace not found
   * - 500: Git command error
   * 
   * @returns BranchesResponse with currentBranch and branches array
   */
  "/api/git/branches": {
    delegation: workspaceOperation("workspace"),
    auth: "user",
    sameOrigin: "mutations",
    description: "List local and cached remote-tracking git branches for a workspace.",
    operations: {
      GET: { requestSchema: undefined, querySchema: WorkspaceGitQuerySchema, automation: { policy: "read" } },
    },
    async GET(req: Request, _ctx): Promise<Response> {
      log.debug("GET /api/git/branches");

      try {
        const result = await validateGitRequest(req);
        if (result instanceof Response) return result;
        const { git, directory } = result;

        const branches = await git.getBranches(directory);
        const currentBranch = branches.find((b) => b.current)?.name ?? "";

        const response: BranchesResponse = {
          currentBranch,
          branches,
        };

        log.debug("Branches retrieved", { directory, currentBranch, branchCount: branches.length });
        return Response.json(response);
      } catch (error) {
        log.error("Git branches error", { error: String(error) });
        return internalErrorResponse(error, {
          error: "git_error",
          message: "Failed to list git branches",
          status: 500,
        });
      }
    },
  },

  /**
   * GET /api/git/default-branch - Get the default branch for a workspace.
   * 
   * Returns the default branch for the repository (typically "main" or "master").
   * Uses detection strategy: origin/HEAD → main → master → current branch.
   * 
   * Query Parameters:
   * - workspaceId (required): Workspace ID
   * 
   * Errors:
   * - 400: Missing workspaceId or not a git repo
   * - 404: Workspace not found
   * - 500: Git command error
   * 
   * @returns DefaultBranchResponse with defaultBranch
   */
  "/api/git/default-branch": {
    delegation: workspaceOperation("workspace"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Detect the default git branch for a workspace.",
    operations: {
      GET: { requestSchema: undefined, querySchema: WorkspaceGitQuerySchema, automation: { policy: "read" } },
    },
    async GET(req: Request, _ctx): Promise<Response> {
      log.debug("GET /api/git/default-branch");

      try {
        const result = await validateGitRequest(req);
        if (result instanceof Response) return result;
        const { git, directory } = result;

        const defaultBranch = result.workspace.workspaceType === "multi-git"
          ? (await resolveRepositoryDefaultBranch(result.executor, directory)).branch
          : await git.getDefaultBranch(directory);

        const response: DefaultBranchResponse = {
          defaultBranch,
        };

        log.debug("Default branch retrieved", { directory, defaultBranch });
        return Response.json(response);
      } catch (error) {
        log.error("Git default-branch error", { error: String(error) });
        return internalErrorResponse(error, {
          error: "git_error",
          message: "Failed to determine the default branch",
          status: 500,
        });
      }
    },
  },

  "/api/git/remote-status": {
    delegation: workspaceOperation("workspace"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Check whether a git remote exists for a workspace.",
    operations: {
      GET: { requestSchema: undefined, querySchema: GitRemoteStatusQuerySchema, automation: { policy: "read" } },
    },
    async GET(req: Request, _ctx): Promise<Response> {
      log.debug("GET /api/git/remote-status");

      try {
        const result = await validateGitRequest(req);
        if (result instanceof Response) return result;
        const { git, directory } = result;
        const url = new URL(req.url);
        const remote = url.searchParams.get("remote")?.trim() || "origin";

        const response: GitRemoteStatusResponse = {
          remote,
          hasRemote: await git.hasRemote(directory, remote),
        };

        log.debug("Remote status retrieved", { directory, remote, hasRemote: response.hasRemote });
        return Response.json(response);
      } catch (error) {
        log.error("Git remote-status error", { error: String(error) });
        return internalErrorResponse(error, {
          error: "git_error",
          message: "Failed to determine git remote status",
          status: 500,
        });
      }
    },
  },

  "/api/git/github-repository-url": {
    delegation: workspaceOperation("workspace"),
    auth: "user",
    sameOrigin: "mutations",
    description: "Resolve the GitHub repository URL for a workspace.",
    operations: {
      GET: { requestSchema: undefined, querySchema: WorkspaceGitQuerySchema, automation: { policy: "read" } },
    },
    async GET(req: Request, _ctx): Promise<Response> {
      log.debug("GET /api/git/github-repository-url");

      try {
        const url = new URL(req.url);
        const workspaceId = url.searchParams.get("workspaceId");

        if (!workspaceId) {
          log.debug("Missing workspaceId parameter");
          return errorResponse("missing_workspace_id", "workspaceId query parameter is required");
        }

        const githubUrl = await resolveGitHubRepositoryUrl(workspaceId, req);
        if (githubUrl instanceof Response) {
          return githubUrl;
        }

        const response: GitHubRepositoryUrlResponse = {
          githubUrl,
        };
        return Response.json(response);
      } catch (error) {
        log.error("GitHub repository URL error", { error: String(error) });
        return internalErrorResponse(error, {
          error: "git_error",
          message: "Failed to determine the GitHub repository URL",
          status: 500,
        });
      }
    },
  },

  "/api/git/github-issues": {
    delegation: workspaceOperation("workspace"),
    auth: "user",
    sameOrigin: "mutations",
    description: "List open GitHub issues for a workspace repository.",
    operations: {
      GET: { requestSchema: undefined, querySchema: WorkspaceGitQuerySchema, automation: { policy: "read" } },
    },
    async GET(req: Request, _ctx): Promise<Response> {
      log.debug("GET /api/git/github-issues");

      try {
        const result = await validateGitRequest(req);
        if (result instanceof Response) return result;

        const githubUrl = await resolveGitHubRepositoryUrlForWorkspace(
          result.workspace,
          result.git,
          result.directory,
        );
        if (!githubUrl) {
          const response: GitHubIssuesResponse = { issues: [] };
          return Response.json(response);
        }

        const issues = await listOpenGitHubIssues(
          result.executor,
          result.directory,
          githubUrl,
        );
        const response: GitHubIssuesResponse = { issues };
        log.debug("GitHub issues retrieved", {
          directory: result.directory,
          issueCount: issues.length,
        });
        return Response.json(response);
      } catch (error) {
        log.warn("GitHub issues error", { error: String(error) });
        return internalErrorResponse(
          error,
          {
            error: "github_issues_error",
            message: "Failed to list GitHub issues",
            status: 500,
          },
          {
            github_issues_command_failed: {
              error: "github_issues_unavailable",
              message: "GitHub issues could not be fetched for this workspace",
              status: 502,
            },
            github_issues_invalid_response: {
              error: "github_issues_invalid_response",
              message: "Clanky API returned an invalid GitHub issues response",
              status: 502,
            },
            github_issues_invalid_repository: {
              error: "github_issues_invalid_repository",
              message: "GitHub issues are not available for this workspace",
              status: 502,
            },
          },
        );
      }
    },
  },
});
