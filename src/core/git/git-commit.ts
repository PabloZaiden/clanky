/**
 * Git commit operations: staging, committing, and related helpers.
 */

import type { CommandExecutor } from "../command-executor";
import { log } from "@pablozaiden/webapp/server";
import { runGitCommand, gitError } from "./git-core";
import { hasStagedChanges } from "./git-repo-query";
import { ensureBranch } from "./git-branch";
import type { CommitOptions, CommitInfo } from "./git-types";

/**
 * Get the subject line of the most recent commit on the current branch.
 * Used to preserve meaningful commit messages for merge commits.
 */
export async function getLastCommitMessage(executor: CommandExecutor, directory: string): Promise<string> {
  const args = ["log", "-1", "--format=%s"];
  const result = await runGitCommand(executor, directory, args);
  if (!result.success) {
    throw gitError("Failed to get last commit message", result, args);
  }
  return result.stdout.trim();
}

export async function stageAll(executor: CommandExecutor, directory: string): Promise<void> {
  const args = ["add", "-A"];
  const result = await runGitCommand(executor, directory, args);
  if (!result.success) {
    throw gitError("Failed to stage changes", result, args);
  }
}

export async function commit(
  executor: CommandExecutor,
  directory: string,
  message: string,
  options: CommitOptions = {}
): Promise<CommitInfo> {
  // Verify branch if expectedBranch is provided (with auto-checkout)
  if (options.expectedBranch) {
    const result = await ensureBranch(executor, directory, options.expectedBranch, { autoCheckout: true });
    if (result.checkedOut) {
      log.info(`[GitService] commit: Auto-recovered to branch '${options.expectedBranch}' before commit`);
    }
  }

  await stageAll(executor, directory);

  const hasChanges = await hasStagedChanges(executor, directory);
  if (!hasChanges) {
    throw new Error("No changes to commit");
  }

  const commitArgs = ["commit", "-m", message];
  const result = await runGitCommand(executor, directory, commitArgs);
  if (!result.success) {
    throw gitError("Failed to commit", result, commitArgs);
  }

  const shaArgs = ["rev-parse", "HEAD"];
  const shaResult = await runGitCommand(executor, directory, shaArgs);
  if (!shaResult.success) {
    throw gitError("Failed to get commit SHA", shaResult, shaArgs);
  }
  const sha = shaResult.stdout.trim();

  const filesResult = await runGitCommand(executor, directory, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    sha,
  ]);
  const filesChanged = filesResult.stdout.replace(/\r\n/g, "\n").trim().split("\n").filter(Boolean).length;

  return { sha, message, filesChanged };
}
