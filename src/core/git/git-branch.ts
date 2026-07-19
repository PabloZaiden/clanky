/**
 * Git branch operations: create, checkout, delete, and branch safety enforcement.
 */

import type { CommandExecutor } from "../command-executor";
import { log } from "@pablozaiden/webapp/server";
import { runGitCommand, gitError } from "./git-core";
import { verifyBranch, hasUncommittedChanges } from "./git-repo-query";
import { BranchMismatchError, InvalidBranchNameError } from "./git-types";
import type { EnsureBranchOptions, EnsureBranchResult } from "./git-types";

export async function assertValidBranchName(
  executor: CommandExecutor,
  directory: string,
  branchName: string,
): Promise<void> {
  const result = await runGitCommand(
    executor,
    directory,
    ["check-ref-format", "--branch", branchName],
    { allowFailure: true },
  );
  if (result.success) {
    return;
  }
  throw new InvalidBranchNameError(branchName);
}

export async function createBranch(
  executor: CommandExecutor,
  directory: string,
  branchName: string
): Promise<void> {
  await assertValidBranchName(executor, directory, branchName);
  const args = ["checkout", "-b", branchName];
  const result = await runGitCommand(executor, directory, args);
  if (!result.success) {
    throw gitError(`Failed to create branch ${branchName}`, result, args);
  }
}

export async function checkoutBranch(
  executor: CommandExecutor,
  directory: string,
  branchName: string
): Promise<void> {
  await assertValidBranchName(executor, directory, branchName);
  const args = ["checkout", branchName];
  const result = await runGitCommand(executor, directory, args);
  if (!result.success) {
    throw gitError(`Failed to checkout branch ${branchName}`, result, args);
  }
}

export async function deleteBranch(
  executor: CommandExecutor,
  directory: string,
  branchName: string
): Promise<void> {
  await assertValidBranchName(executor, directory, branchName);
  const args = ["branch", "-D", branchName];
  const result = await runGitCommand(executor, directory, args);
  if (!result.success) {
    throw gitError(`Failed to delete branch ${branchName}`, result, args);
  }
}

export async function ensureBranch(
  executor: CommandExecutor,
  directory: string,
  expectedBranch: string,
  options: EnsureBranchOptions = {}
): Promise<EnsureBranchResult> {
  await assertValidBranchName(executor, directory, expectedBranch);
  const { autoCheckout = false } = options;

  const verification = await verifyBranch(executor, directory, expectedBranch);

  if (verification.matches) {
    return {
      wasOnExpectedBranch: true,
      currentBranch: verification.currentBranch,
      expectedBranch: verification.expectedBranch,
      checkedOut: false,
    };
  }

  if (!autoCheckout) {
    throw new BranchMismatchError(verification.currentBranch, expectedBranch);
  }

  // Auto-checkout requested - check for uncommitted changes first
  const hasChanges = await hasUncommittedChanges(executor, directory);
  if (hasChanges) {
    throw new Error(
      `Cannot auto-checkout to '${expectedBranch}': uncommitted changes exist. ` +
      `Currently on '${verification.currentBranch}'.`
    );
  }

  log.info(`[GitService] Auto-checkout: switching from '${verification.currentBranch}' to '${expectedBranch}'`);
  await checkoutBranch(executor, directory, expectedBranch);

  return {
    wasOnExpectedBranch: false,
    currentBranch: verification.currentBranch,
    expectedBranch,
    checkedOut: true,
  };
}
