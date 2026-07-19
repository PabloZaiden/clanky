/**
 * Git merge, reset, and conflict resolution operations.
 */

import type { CommandExecutor } from "../command-executor";
import { log } from "@pablozaiden/webapp/server";
import { runGitCommand, gitError } from "./git-core";
import { verifyBranch, getConflictedFiles } from "./git-repo-query";
import { checkoutBranch } from "./git-branch";
import type { ResetHardOptions, MergeAttemptResult } from "./git-types";

export async function resetHard(
  executor: CommandExecutor,
  directory: string,
  options: ResetHardOptions = {}
): Promise<void> {
  if (options.expectedBranch) {
    const verification = await verifyBranch(executor, directory, options.expectedBranch);
    if (!verification.matches) {
      log.info(`[GitService] resetHard: Force switching from '${verification.currentBranch}' to '${options.expectedBranch}' before reset`);
      const checkoutArgs = ["checkout", "-f", options.expectedBranch];
      const checkoutResult = await runGitCommand(executor, directory, checkoutArgs);
      if (!checkoutResult.success) {
        throw gitError(`Failed to force checkout branch ${options.expectedBranch}`, checkoutResult, checkoutArgs);
      }
    }
  }

  const resetArgs = ["reset", "--hard"];
  const resetResult = await runGitCommand(executor, directory, resetArgs);
  if (!resetResult.success) {
    throw gitError("Failed to reset", resetResult, resetArgs);
  }

  const cleanArgs = ["clean", "-fd"];
  const cleanResult = await runGitCommand(executor, directory, cleanArgs);
  if (!cleanResult.success) {
    throw gitError("Failed to clean untracked files", cleanResult, cleanArgs);
  }
}

export async function mergeBranch(
  executor: CommandExecutor,
  directory: string,
  sourceBranch: string,
  targetBranch: string
): Promise<string> {
  await checkoutBranch(executor, directory, targetBranch);

  const mergeArgs = [
    "merge",
    sourceBranch,
    "--no-ff",
    "-m",
    `Merge branch '${sourceBranch}' into ${targetBranch}`,
  ];
  const result = await runGitCommand(executor, directory, mergeArgs);
  if (!result.success) {
    throw gitError(`Failed to merge ${sourceBranch} into ${targetBranch}`, result, mergeArgs);
  }

  const shaArgs = ["rev-parse", "HEAD"];
  const shaResult = await runGitCommand(executor, directory, shaArgs);
  if (!shaResult.success) {
    throw gitError("Failed to get merge commit SHA", shaResult, shaArgs);
  }

  return shaResult.stdout.trim();
}

export async function mergeWithConflictDetection(
  executor: CommandExecutor,
  directory: string,
  sourceBranch: string,
  message?: string
): Promise<MergeAttemptResult> {
  const args = ["merge", "--no-ff", sourceBranch];
  if (message) {
    args.push("-m", message);
  }

  const result = await runGitCommand(executor, directory, args, { allowFailure: true });

  // Check for "already up to date"
  if (result.success && (
    result.stdout.toLowerCase().includes("already up to date") ||
    result.stdout.toLowerCase().includes("already up-to-date")
  )) {
    return { success: true, alreadyUpToDate: true, hasConflicts: false };
  }

  // Clean merge succeeded
  if (result.success) {
    const shaResult = await runGitCommand(executor, directory, ["rev-parse", "HEAD"]);
    return {
      success: true,
      alreadyUpToDate: false,
      hasConflicts: false,
      mergeCommitSha: shaResult.success ? shaResult.stdout.trim() : undefined,
    };
  }

  // Merge failed — check if it's due to conflicts
  const hasConflicts =
    result.stderr.includes("CONFLICT") ||
    result.stderr.includes("Automatic merge failed") ||
    result.stdout.includes("CONFLICT") ||
    result.stdout.includes("Automatic merge failed");

  if (hasConflicts) {
    const conflictedFiles = await getConflictedFiles(executor, directory);
    return {
      success: false,
      alreadyUpToDate: false,
      hasConflicts: true,
      conflictedFiles,
      stderr: result.stderr,
    };
  }

  return {
    success: false,
    alreadyUpToDate: false,
    hasConflicts: false,
    stderr: result.stderr,
  };
}

export async function abortMerge(executor: CommandExecutor, directory: string): Promise<void> {
  const args = ["merge", "--abort"];
  const result = await runGitCommand(executor, directory, args);
  if (!result.success) {
    throw gitError("Failed to abort merge", result, args);
  }
}

export async function ensureMergeStrategy(executor: CommandExecutor, directory: string): Promise<boolean> {
  const checkResult = await runGitCommand(
    executor,
    directory,
    ["config", "pull.rebase"],
    { allowFailure: true }
  );

  if (checkResult.success) {
    log.debug(`[GitService] pull.rebase already configured: ${checkResult.stdout.trim()}`);
    return true;
  }

  const setResult = await runGitCommand(executor, directory, ["config", "pull.rebase", "false"]);

  if (!setResult.success) {
    log.warn(`[GitService] Failed to set pull.rebase: ${setResult.stderr}`);
    return false;
  }

  log.debug(`[GitService] Set pull.rebase to false`);
  return true;
}
