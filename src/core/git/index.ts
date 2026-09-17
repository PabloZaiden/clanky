/**
 * Git service for Clanky Tasks Management System.
 * Provides git operations using a CommandExecutor abstraction.
 * All operations are isolated to a specific directory.
 *
 * This file is the public facade — GitService delegates to sub-module functions.
 */

import type { CommandExecutor } from "../command-executor";

// Re-export all public types so callers can import from this module
export {
  BranchMismatchError,
  GitCommandError,
  InvalidBranchNameError,
} from "./git-types";
export { InvalidManagedWorktreePathError } from "../managed-path-service";
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
  worktreePathComparisonKey,
} from "./git-worktree";
import {
  ManagedPathService,
} from "../managed-path-service";

export { MANAGED_WORKTREE_DIRECTORY_NAME, ManagedPathService } from "../managed-path-service";

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
  private readonly managedPaths: ManagedPathService;

  /**
   * Create a new GitService.
   * @param executor - The command executor to use (required)
   */
  constructor(executor: CommandExecutor) {
    this.executor = executor;
    this.managedPaths = new ManagedPathService(executor.pathStyle);
  }

  /**
   * Create a new GitService with the specified executor.
   */
  static withExecutor(executor: CommandExecutor): GitService {
    return new GitService(executor);
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

  getManagedWorktreeRoot(repoDirectory: string): string {
    return this.managedPaths.getManagedWorktreeRoot(repoDirectory);
  }

  normalizeManagedWorktreeIdentifier(identifier: string): string {
    return this.managedPaths.normalizeManagedWorktreeIdentifier(identifier);
  }

  getManagedWorktreePath(repoDirectory: string, identifier: string): string {
    return this.managedPaths.getManagedWorktreePath(repoDirectory, identifier);
  }

  isManagedWorktreePath(repoDirectory: string, worktreePath: string): boolean {
    return this.managedPaths.isManagedWorktreePath(repoDirectory, worktreePath);
  }

  assertManagedWorktreePath(repoDirectory: string, worktreePath: string): string {
    return this.managedPaths.assertManagedWorktreePath(repoDirectory, worktreePath);
  }

  assertCanonicalManagedWorktreePath(
    repoDirectory: string,
    identifier: string,
    worktreePath: string,
  ): string {
    return this.managedPaths.assertCanonicalManagedWorktreePath(
      repoDirectory,
      identifier,
      worktreePath,
    );
  }

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
    const managedWorktreePath = this.managedPaths.assertManagedWorktreePath(
      repoDirectory,
      worktreePath,
    );
    // Use this.listWorktrees() so test mocks of listWorktrees are respected
    const worktrees = await this.listWorktrees(repoDirectory);
    const comparablePaths = await getComparableWorktreePaths(this.executor, managedWorktreePath);
    return worktrees.some((wt) => comparablePaths.has(
      worktreePathComparisonKey(wt.path, this.executor.pathStyle),
    ));
  }

  async ensureWorktreeExcluded(repoDirectory: string): Promise<void> {
    return ensureWorktreeExcluded(this.executor, repoDirectory);
  }
}

// Note: No singleton instance - GitService must be created with an executor
// Use backendManager.getCommandExecutorAsync() to get an executor
