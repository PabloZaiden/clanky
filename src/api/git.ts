/**
 * Git API endpoints for Clanky Tasks Management System.
 * 
 * This module provides git-related endpoints for querying repository information.
 * All git operations use the deterministic CommandExecutor abstraction
 * (local or SSH execution providers).
 * 
 * Endpoints:
 * - GET /api/git/branches - Get all local branches for a workspace
 * 
 * @module api/git
 */

import { backendManager } from "../core/backend-manager";
import { GitCommandError, GitService } from "../core/git";
import { normalizeGitHubRepositoryUrl } from "../lib/github-repository-url";
import type { BranchInfo, GitHubRepositoryUrlResponse, GitRemoteStatusResponse, Workspace } from "../types";
import { createLogger } from "../core/logger";
import { errorResponse, requireWorkspace } from "./helpers";

const log = createLogger("api:git");

/**
 * Response for GET /api/git/branches endpoint.
 */
export interface BranchesResponse {
  /** Name of the currently checked out branch */
  currentBranch: string;
  /** All local branches in the repository */
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
): Promise<string | null | Response> {
  const workspaceResult = await requireWorkspace(workspaceId);
  if (workspaceResult instanceof Response) {
    return workspaceResult;
  }
  const workspace = workspaceResult;
  const directory = workspace.directory;

  const persistedRepoUrl = workspace.repoUrl?.trim() ?? "";
  if (persistedRepoUrl) {
    return normalizeGitHubRepositoryUrl(persistedRepoUrl);
  }

  const git = await createGitServiceForWorkspace(workspace);

  if (!(await git.isGitRepo(directory))) {
    return null;
  }

  try {
    const remoteUrl = await git.getRemoteUrl(directory, "origin");
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

async function createGitServiceForWorkspace(workspace: Workspace): Promise<GitService> {
  const executor = await backendManager.getCommandExecutorAsync(workspace.id, workspace.directory);
  return GitService.withExecutor(executor);
}

/**
 * Get a GitService configured for the current execution provider.
 * Uses deterministic command execution (local/SSH), independent of agent transport.
 *
 * @param workspace - Workspace containing the repository
 * @returns Configured GitService instance on success, or an error Response
 */
async function getGitService(workspace: Workspace): Promise<GitService> {
  log.debug("Getting GitService for workspace", { workspaceId: workspace.id, directory: workspace.directory });
  log.debug("GitService created", { workspaceId: workspace.id });
  return createGitServiceForWorkspace(workspace);
}

/** Validate a workspace git request and verify its repository. */
async function validateGitRequest(req: Request): Promise<
  { git: GitService; directory: string } | Response
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

  const git = await getGitService(workspace);
  const directory = workspace.directory;
  const isGitRepo = await git.isGitRepo(directory);
  if (!isGitRepo) {
    log.debug("Workspace directory is not a git repository", {
      workspaceId: workspace.id,
      directory,
    });
    return errorResponse("not_git_repo", "Workspace directory is not a git repository");
  }

  return { git, directory };
}

/**
 * Git API routes.
 * 
 * Provides endpoints for git repository information:
 * - GET /api/git/branches - List all local branches
 */
export const gitRoutes = {
  /**
   * GET /api/git/branches - Get all local branches for a workspace.
   * 
   * Returns the list of local branches and identifies which one is current.
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
    async GET(req: Request): Promise<Response> {
      log.debug("GET /api/git/branches");

      try {
        const result = await validateGitRequest(req);
        if (result instanceof Response) return result;
        const { git, directory } = result;

        const branches = await git.getLocalBranches(directory);
        const currentBranch = branches.find((b) => b.current)?.name ?? "";

        const response: BranchesResponse = {
          currentBranch,
          branches,
        };

        log.debug("Branches retrieved", { directory, currentBranch, branchCount: branches.length });
        return Response.json(response);
      } catch (error) {
        log.error("Git branches error", { error: String(error) });
        return errorResponse("git_error", String(error), 500);
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
    async GET(req: Request): Promise<Response> {
      log.debug("GET /api/git/default-branch");

      try {
        const result = await validateGitRequest(req);
        if (result instanceof Response) return result;
        const { git, directory } = result;

        const defaultBranch = await git.getDefaultBranch(directory);

        const response: DefaultBranchResponse = {
          defaultBranch,
        };

        log.debug("Default branch retrieved", { directory, defaultBranch });
        return Response.json(response);
      } catch (error) {
        log.error("Git default-branch error", { error: String(error) });
        return errorResponse("git_error", String(error), 500);
      }
    },
  },

  "/api/git/remote-status": {
    async GET(req: Request): Promise<Response> {
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
        return errorResponse("git_error", String(error), 500);
      }
    },
  },

  "/api/git/github-repository-url": {
    async GET(req: Request): Promise<Response> {
      log.debug("GET /api/git/github-repository-url");

      try {
        const url = new URL(req.url);
        const workspaceId = url.searchParams.get("workspaceId");

        if (!workspaceId) {
          log.debug("Missing workspaceId parameter");
          return errorResponse("missing_workspace_id", "workspaceId query parameter is required");
        }

        const githubUrl = await resolveGitHubRepositoryUrl(workspaceId);
        if (githubUrl instanceof Response) {
          return githubUrl;
        }

        const response: GitHubRepositoryUrlResponse = {
          githubUrl,
        };
        return Response.json(response);
      } catch (error) {
        log.error("GitHub repository URL error", { error: String(error) });
        return errorResponse("git_error", String(error), 500);
      }
    },
  },
};
