/**
 * Git service for Clanky Tasks Management System.
 * Provides git operations using a CommandExecutor abstraction.
 * All operations are isolated to a specific directory.
 *
 * This file is the public facade — GitService delegates to sub-module functions.
 */

import type { CommandExecutor } from "../command-executor";
import { log } from "../logger";

// Re-export all public types so callers can import from this module
export {
  BranchMismatchError,
  GitCommandError,
  InvalidBranchNameError,
} from "./git-types";
export type {
  GitCommandResult,
  BranchVerificationResult,
  EnsureBranchOptions,
  EnsureBranchResult,
  CommitOptions,
  ResetHardOptions,
  StashOptions,
  MergeAttemptResult,
  FileDiff,
  FileDiffWithContent,
  CommitInfo,
} from "./git-types";

// Sub-module imports
import { isGitRepo, getCurrentBranch, getLocalBranches, getDefaultBranch, verifyBranch, hasUncommittedChanges, getChangedFiles, branchExists, hasStagedChanges, isAncestor, getConflictedFiles } from "./git-repo-query";
import { getRemoteUrl as getRemoteUrlRemote, hasRemote as hasRemoteRemote, pushBranch, fetchBranch, pull, pullBranch } from "./git-remote";
import { assertValidBranchName, createBranch, checkoutBranch, deleteBranch, ensureBranch } from "./git-branch";
import { stageAll, commit, getLastCommitMessage } from "./git-commit";
import { stash, stashPop } from "./git-stash";
import { resetHard, mergeBranch, mergeWithConflictDetection, abortMerge, ensureMergeStrategy } from "./git-merge";
import { getDiff, getDiffSummary, getFileDiffContent, getDiffWithContent } from "./git-diff";
import {
  createWorktree,
  addWorktreeForExistingBranch,
  removeWorktree,
  ensureWorktreeRemoved,
  listWorktrees,
  pruneWorktrees,
  ensureWorktreeExcluded,
  getComparableWorktreePaths,
  normalizeWorktreePath,
} from "./git-worktree";

import type {
  BranchVerificationResult,
  EnsureBranchOptions,
  EnsureBranchResult,
  CommitOptions,
  ResetHardOptions,
  StashOptions,
  MergeAttemptResult,
  FileDiff,
  FileDiffWithContent,
  CommitInfo,
} from "./git-types";

/**
 * GitService provides git operations for Clanky Tasks.
 * Uses a CommandExecutor for running git commands, allowing for both
 * local execution (`stdio` transport) and remote execution (`ssh` transport).
 */
export class GitService {
  private executor: CommandExecutor;

  /**
   * Create a new GitService.
   * @param executor - The command executor to use (required)
   */
  constructor(executor: CommandExecutor) {
    this.executor = executor;
  }

  /**
   * Create a new GitService with the specified executor.
   */
  static withExecutor(executor: CommandExecutor): GitService {
    return new GitService(executor);
  }

  /**
   * Clean up stale git lock files that may have been left behind by crashed processes.
   * This is especially important when a task is forcefully stopped while git operations
   * are in progress.
   *
   * Handles both regular repos (lock at `.git/index.lock`) and worktrees
   * (lock at the gitdir path referenced by the `.git` file).
   *
   * @param directory - The git repository or worktree directory
   * @param retries - Number of times to retry cleanup (default: 3)
   * @param delayMs - Delay between retries in milliseconds (default: 100)
   * @returns true if any lock files were cleaned up, false otherwise
   */
  static async cleanupStaleLockFiles(directory: string, retries = 3, delayMs = 100): Promise<boolean> {
    const path = await import("path");
    const { rm, stat, readFile } = await import("fs/promises");

    let lockFile: string;
    const dotGitPath = path.join(directory, ".git");

    try {
      const dotGitStat = await stat(dotGitPath);
      if (dotGitStat.isFile()) {
        const content = await readFile(dotGitPath, "utf-8");
        const match = content.match(/^gitdir:\s*(.+)$/m);
        if (match?.[1]) {
          const gitDir = match[1].trim();
          const resolvedGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(directory, gitDir);
          lockFile = path.join(resolvedGitDir, "index.lock");
        } else {
          lockFile = path.join(directory, ".git", "index.lock");
        }
      } else {
        lockFile = path.join(directory, ".git", "index.lock");
      }
    } catch {
      return false;
    }

    let cleaned = false;

    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        await stat(lockFile);
        log.info(`[GitService] Removing stale lock file: ${lockFile} (attempt ${attempt + 1}/${retries})`);
        await rm(lockFile, { force: true });
        cleaned = true;

        if (attempt < retries - 1) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      } catch {
        break;
      }
    }

    return cleaned;
  }

  // ─── Read-only queries ────────────────────────────────────────────────────

  async isGitRepo(directory: string): Promise<boolean> {
    return isGitRepo(this.executor, directory);
  }

  async getCurrentBranch(directory: string): Promise<string> {
    return getCurrentBranch(this.executor, directory);
  }

  async getLocalBranches(directory: string): Promise<{ name: string; current: boolean }[]> {
    return getLocalBranches(this.executor, directory);
  }

  async getDefaultBranch(directory: string): Promise<string> {
    return getDefaultBranch(this.executor, directory);
  }

  async getRemoteUrl(directory: string, remote = "origin"): Promise<string> {
    return getRemoteUrlRemote(this.executor, directory, remote);
  }

  async hasRemote(directory: string, remote = "origin"): Promise<boolean> {
    return hasRemoteRemote(this.executor, directory, remote);
  }

  async verifyBranch(directory: string, expectedBranch: string): Promise<BranchVerificationResult> {
    return verifyBranch(this.executor, directory, expectedBranch);
  }

  async hasUncommittedChanges(directory: string): Promise<boolean> {
    return hasUncommittedChanges(this.executor, directory);
  }

  async getChangedFiles(directory: string): Promise<string[]> {
    return getChangedFiles(this.executor, directory);
  }

  async branchExists(
    directory: string,
    branchName: string,
    options: { allowFailure?: boolean } = { allowFailure: true }
  ): Promise<boolean> {
    return branchExists(this.executor, directory, branchName, options);
  }

  async hasStagedChanges(directory: string): Promise<boolean> {
    return hasStagedChanges(this.executor, directory);
  }

  async isAncestor(directory: string, ancestorRef: string, descendantRef: string): Promise<boolean> {
    return isAncestor(this.executor, directory, ancestorRef, descendantRef);
  }

  async getConflictedFiles(directory: string): Promise<string[]> {
    return getConflictedFiles(this.executor, directory);
  }

  // ─── Branch operations ────────────────────────────────────────────────────

  async createBranch(directory: string, branchName: string): Promise<void> {
    return createBranch(this.executor, directory, branchName);
  }

  async assertValidBranchName(directory: string, branchName: string): Promise<void> {
    return assertValidBranchName(this.executor, directory, branchName);
  }

  async checkoutBranch(directory: string, branchName: string): Promise<void> {
    return checkoutBranch(this.executor, directory, branchName);
  }

  async deleteBranch(directory: string, branchName: string): Promise<void> {
    return deleteBranch(this.executor, directory, branchName);
  }

  async ensureBranch(
    directory: string,
    expectedBranch: string,
    options: EnsureBranchOptions = {}
  ): Promise<EnsureBranchResult> {
    return ensureBranch(this.executor, directory, expectedBranch, options);
  }

  // ─── Commit operations ────────────────────────────────────────────────────

  async stageAll(directory: string): Promise<void> {
    return stageAll(this.executor, directory);
  }

  async commit(directory: string, message: string, options: CommitOptions = {}): Promise<CommitInfo> {
    return commit(this.executor, directory, message, options);
  }

  async getLastCommitMessage(directory: string): Promise<string> {
    return getLastCommitMessage(this.executor, directory);
  }

  // ─── Stash operations ─────────────────────────────────────────────────────

  async stash(directory: string, options: StashOptions = {}): Promise<void> {
    return stash(this.executor, directory, options);
  }

  async stashPop(directory: string, options: StashOptions = {}): Promise<void> {
    return stashPop(this.executor, directory, options);
  }

  // ─── Merge / reset operations ─────────────────────────────────────────────

  async resetHard(directory: string, options: ResetHardOptions = {}): Promise<void> {
    return resetHard(this.executor, directory, options);
  }

  async mergeBranch(directory: string, sourceBranch: string, targetBranch: string): Promise<string> {
    return mergeBranch(this.executor, directory, sourceBranch, targetBranch);
  }

  async mergeWithConflictDetection(
    directory: string,
    sourceBranch: string,
    message?: string
  ): Promise<MergeAttemptResult> {
    return mergeWithConflictDetection(this.executor, directory, sourceBranch, message);
  }

  async abortMerge(directory: string): Promise<void> {
    return abortMerge(this.executor, directory);
  }

  async ensureMergeStrategy(directory: string): Promise<boolean> {
    return ensureMergeStrategy(this.executor, directory);
  }

  // ─── Remote operations ────────────────────────────────────────────────────

  async pushBranch(directory: string, branchName: string, remote = "origin"): Promise<string> {
    return pushBranch(this.executor, directory, branchName, remote);
  }

  async fetchBranch(directory: string, branchName: string, remote = "origin"): Promise<boolean> {
    return fetchBranch(this.executor, directory, branchName, remote);
  }

  async pull(directory: string, branchName?: string, remote = "origin"): Promise<boolean> {
    return pull(this.executor, directory, branchName, remote);
  }

  async pullBranch(directory: string, branchName: string, remote = "origin"): Promise<void> {
    return pullBranch(this.executor, directory, branchName, remote);
  }

  // ─── Diff operations ──────────────────────────────────────────────────────

  async getDiff(directory: string, baseBranch: string): Promise<FileDiff[]> {
    return getDiff(this.executor, directory, baseBranch);
  }

  async getDiffSummary(
    directory: string,
    baseBranch: string
  ): Promise<{ files: number; insertions: number; deletions: number }> {
    return getDiffSummary(this.executor, directory, baseBranch);
  }

  async getFileDiffContent(directory: string, baseBranch: string, filePath: string): Promise<string> {
    return getFileDiffContent(this.executor, directory, baseBranch, filePath);
  }

  async getDiffWithContent(directory: string, baseBranch: string): Promise<FileDiffWithContent[]> {
    return getDiffWithContent(this.executor, directory, baseBranch);
  }

  // ─── Worktree operations ──────────────────────────────────────────────────

  async createWorktree(
    repoDirectory: string,
    worktreePath: string,
    branchName: string,
    baseBranch?: string
  ): Promise<void> {
    return createWorktree(this.executor, repoDirectory, worktreePath, branchName, baseBranch);
  }

  async addWorktreeForExistingBranch(
    repoDirectory: string,
    worktreePath: string,
    branchName: string
  ): Promise<void> {
    return addWorktreeForExistingBranch(this.executor, repoDirectory, worktreePath, branchName);
  }

  async removeWorktree(
    repoDirectory: string,
    worktreePath: string,
    options?: { force?: boolean }
  ): Promise<void> {
    return removeWorktree(this.executor, repoDirectory, worktreePath, options);
  }

  async ensureWorktreeRemoved(
    repoDirectory: string,
    worktreePath: string,
    options?: { force?: boolean }
  ): Promise<void> {
    return ensureWorktreeRemoved(this.executor, repoDirectory, worktreePath, options);
  }

  async listWorktrees(
    repoDirectory: string
  ): Promise<Array<{ path: string; head: string; branch: string }>> {
    return listWorktrees(this.executor, repoDirectory);
  }

  async pruneWorktrees(repoDirectory: string): Promise<void> {
    return pruneWorktrees(this.executor, repoDirectory);
  }

  async worktreeExists(repoDirectory: string, worktreePath: string): Promise<boolean> {
    // Use this.listWorktrees() so test mocks of listWorktrees are respected
    const worktrees = await this.listWorktrees(repoDirectory);
    const comparablePaths = await getComparableWorktreePaths(this.executor, worktreePath);
    return worktrees.some((wt) => comparablePaths.has(normalizeWorktreePath(wt.path)));
  }

  async ensureWorktreeExcluded(repoDirectory: string): Promise<void> {
    return ensureWorktreeExcluded(this.executor, repoDirectory);
  }
}

// Note: No singleton instance - GitService must be created with an executor
// Use backendManager.getCommandExecutorAsync() to get an executor
