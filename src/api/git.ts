/**
 * Git API endpoints for Ralph Loops Management System.
 * 
 * This module provides git-related endpoints for querying repository information.
 * All git operations use the deterministic CommandExecutor abstraction
 * (local or SSH execution providers).
 * 
 * Endpoints:
 * - GET /api/git/branches - Get all local branches for a directory
 * 
 * @module api/git
 */

import { backendManager } from "../core/backend-manager";
import { GitCommandError, GitService } from "../core/git";
import { normalizeGitHubRepositoryUrl } from "../lib/github-repository-url";
import type { BranchInfo, GitHubRepositoryUrlResponse, Workspace } from "../types";
import { createLogger } from "../core/logger";
import { errorResponse, normalizeDirectoryPath, resolveWorkspaceForDirectory } from "./helpers";

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
  directory: string,
  workspaceId?: string | null,
): Promise<string | null | Response> {
  const normalizedDirectory = normalizeDirectoryPath(directory);
  const workspace = await resolveWorkspaceForDirectory(normalizedDirectory, workspaceId);
  if (workspace instanceof Response) {
    return workspace;
  }

  const persistedRepoUrl = workspace.repoUrl?.trim() ?? "";
  if (persistedRepoUrl) {
    return normalizeGitHubRepositoryUrl(persistedRepoUrl);
  }

  const git = await createGitServiceForWorkspace(workspace, normalizedDirectory);

  if (!(await git.isGitRepo(normalizedDirectory))) {
    return null;
  }

  try {
    const remoteUrl = await git.getRemoteUrl(normalizedDirectory, "origin");
    return normalizeGitHubRepositoryUrl(remoteUrl);
  } catch (error) {
    if (error instanceof GitCommandError) {
      log.info("GitHub repository URL unavailable from origin remote", {
        workspaceId: workspace.id,
        directory: normalizedDirectory,
        command: error.command,
        exitCode: error.exitCode,
        gitStderr: error.gitStderr,
      });
      return null;
    }
    throw error;
  }
}

async function createGitServiceForWorkspace(workspace: Workspace, directory: string): Promise<GitService> {
  const normalizedDirectory = normalizeDirectoryPath(directory);
  const executor = await backendManager.getCommandExecutorAsync(workspace.id, normalizedDirectory);
  return GitService.withExecutor(executor);
}

/**
 * Get a GitService configured for the current execution provider.
 * Uses deterministic command execution (local/SSH), independent of agent transport.
 * This helper never throws for missing or ambiguous workspaces; lookup failures
 * are returned as `Response` objects from `resolveWorkspaceForDirectory()`.
 * 
 * @param directory - The directory containing the git repository
 * @param workspaceId - Optional workspace ID used to disambiguate identical directories
 * @returns Configured GitService instance on success, or an error Response
 */
async function getGitService(directory: string, workspaceId?: string | null): Promise<GitService | Response> {
  const normalizedDirectory = normalizeDirectoryPath(directory);
  log.debug("Getting GitService for directory", { directory: normalizedDirectory, workspaceId });
  const workspace = await resolveWorkspaceForDirectory(normalizedDirectory, workspaceId);
  if (workspace instanceof Response) {
    return workspace;
  }
  log.debug("GitService created", { workspaceId: workspace.id });
  return createGitServiceForWorkspace(workspace, normalizedDirectory);
}

/**
 * Validate git request: extract directory, get GitService, and verify it's a git repo.
 * Shared boilerplate for all git endpoints.
 *
 * @returns Object with git service and directory on success, or an error Response
 */
async function validateGitRequest(req: Request): Promise<
  { git: GitService; directory: string } | Response
> {
  const url = new URL(req.url);
  const directory = url.searchParams.get("directory");
  const workspaceId = url.searchParams.get("workspaceId");

  if (!directory) {
    log.debug("Missing directory parameter");
    return errorResponse("missing_parameter", "directory query parameter is required");
  }

  const normalizedDirectory = normalizeDirectoryPath(directory);
  const git = await getGitService(normalizedDirectory, workspaceId);
  if (git instanceof Response) {
    return git;
  }

  const isGitRepo = await git.isGitRepo(normalizedDirectory);
  if (!isGitRepo) {
    log.debug("Directory is not a git repository", { directory: normalizedDirectory });
    return errorResponse("not_git_repo", "Directory is not a git repository");
  }

  return { git, directory: normalizedDirectory };
}

/**
 * Git API routes.
 * 
 * Provides endpoints for git repository information:
 * - GET /api/git/branches - List all local branches
 */
export const gitRoutes = {
  /**
   * GET /api/git/branches - Get all local branches for a directory.
   * 
   * Returns the list of local branches and identifies which one is current.
   * Validates that the directory is a git repository.
   * 
   * Query Parameters:
   * - directory (required): Path to the git repository
   * - workspaceId (optional): Workspace ID used to disambiguate shared directories
   * 
   * Errors:
   * - 400: Missing directory parameter, directory mismatch, or not a git repo
   * - 404: Workspace not found
   * - 409: Multiple workspaces use this directory and workspaceId was not provided
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
   * GET /api/git/default-branch - Get the repository's default branch.
   * 
   * Returns the default branch for the repository (typically "main" or "master").
   * Uses detection strategy: origin/HEAD → main → master → current branch.
   * 
   * Query Parameters:
   * - directory (required): Path to the git repository
   * - workspaceId (optional): Workspace ID used to disambiguate shared directories
   * 
   * Errors:
   * - 400: Missing directory parameter, directory mismatch, or not a git repo
   * - 404: Workspace not found
   * - 409: Multiple workspaces use this directory and workspaceId was not provided
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

  "/api/git/github-repository-url": {
    async GET(req: Request): Promise<Response> {
      log.debug("GET /api/git/github-repository-url");

      try {
        const url = new URL(req.url);
        const directory = url.searchParams.get("directory");
        const workspaceId = url.searchParams.get("workspaceId");

        if (!directory) {
          log.debug("Missing directory parameter");
          return errorResponse("missing_parameter", "directory query parameter is required");
        }

        const githubUrl = await resolveGitHubRepositoryUrl(directory, workspaceId);
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
