/**
 * Shared types and error classes for git operations.
 */

/**
 * Error thrown when the current branch doesn't match the expected branch.
 * Used for branch safety verification before git operations.
 */
export class BranchMismatchError extends Error {
  readonly code = "BRANCH_MISMATCH";
  readonly currentBranch: string;
  readonly expectedBranch: string;

  constructor(currentBranch: string, expectedBranch: string) {
    super(`Branch mismatch: expected '${expectedBranch}' but on '${currentBranch}'`);
    this.name = "BranchMismatchError";
    this.currentBranch = currentBranch;
    this.expectedBranch = expectedBranch;
  }
}

/**
 * Error thrown when a git command fails.
 * Preserves the command, exit code, and stderr for debugging.
 */
export class GitCommandError extends Error {
  readonly code = "GIT_COMMAND_FAILED";
  readonly command: string;
  readonly exitCode: number;
  readonly gitStderr: string;

  constructor(message: string, command: string, exitCode: number, stderr: string) {
    super(message);
    this.name = "GitCommandError";
    this.command = command;
    this.exitCode = exitCode;
    this.gitStderr = stderr;
  }
}

/**
 * Error thrown when a branch name fails git ref validation.
 */
export class InvalidBranchNameError extends Error {
  readonly code = "INVALID_BRANCH_NAME";
  readonly branchName: string;

  constructor(branchName: string, message = `Invalid git branch name: '${branchName}'`) {
    super(message);
    this.name = "InvalidBranchNameError";
    this.branchName = branchName;
  }
}

/**
 * Error thrown when a managed worktree identifier or path is unsafe.
 */
export class InvalidManagedWorktreePathError extends Error {
  readonly code = "INVALID_MANAGED_WORKTREE_PATH";
  readonly path: string;

  constructor(path: string, message = `Invalid managed worktree path: '${path}'`) {
    super(message);
    this.name = "InvalidManagedWorktreePathError";
    this.path = path;
  }
}

/**
 * Result of a git command execution.
 */
export interface GitCommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Result of verifying the current branch.
 */
export interface BranchVerificationResult {
  /** Whether the current branch matches the expected branch */
  matches: boolean;
  /** The current branch name */
  currentBranch: string;
  /** The expected branch name */
  expectedBranch: string;
}

/**
 * Options for ensureBranch() method.
 */
export interface EnsureBranchOptions {
  /** If true, checkout the expected branch if mismatch (default: false) */
  autoCheckout?: boolean;
}

/**
 * Result of ensuring the correct branch.
 */
export interface EnsureBranchResult {
  /** Whether the repo was already on the expected branch */
  wasOnExpectedBranch: boolean;
  /** The current branch name (before any checkout) */
  currentBranch: string;
  /** The expected branch name */
  expectedBranch: string;
  /** True if auto-checkout was performed */
  checkedOut?: boolean;
}

/**
 * Options for commit operation with branch verification.
 */
export interface CommitOptions {
  /** Expected branch to verify before committing. If set and mismatch, will auto-checkout. */
  expectedBranch?: string;
}

/**
 * Options for resetHard operation with branch verification.
 */
export interface ResetHardOptions {
  /**
   * Expected branch to verify before resetting.
   * If set and there is a mismatch, resetHard will directly checkout the expected branch
   * without performing the additional safety checks used by other operations.
   */
  expectedBranch?: string;
}

/**
 * Options for stash operations with branch verification.
 */
export interface StashOptions {
  /** Expected branch to verify before stashing. If set and mismatch, will auto-checkout. */
  expectedBranch?: string;
}

/**
 * Result of a merge attempt with conflict detection.
 */
export interface MergeAttemptResult {
  /** Whether the merge was successful (no conflicts) */
  success: boolean;
  /** Whether the branches were already up to date (no merge needed) */
  alreadyUpToDate: boolean;
  /** Whether there were merge conflicts */
  hasConflicts: boolean;
  /** The merge commit SHA (if successful) */
  mergeCommitSha?: string;
  /** List of files with conflicts (if any) */
  conflictedFiles?: string[];
  /** Raw stderr output from the merge command */
  stderr?: string;
}

/**
 * File diff information.
 */
export interface FileDiff {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  oldPath?: string;
}

/**
 * Extended file diff with actual diff content.
 */
export interface FileDiffWithContent extends FileDiff {
  /** The actual diff patch content */
  patch?: string;
}

/**
 * Git commit information.
 */
export interface CommitInfo {
  sha: string;
  message: string;
  filesChanged: number;
}
