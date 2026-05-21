/**
 * Read-only git repository query operations.
 */

import type { CommandExecutor } from "../command-executor";
import { log } from "../logger";
import { runGitCommand, gitError } from "./git-core";
import type {
  GitCommandResult,
  BranchVerificationResult,
} from "./git-types";

export async function isGitRepo(executor: CommandExecutor, directory: string): Promise<boolean> {
  const result = await runGitCommand(executor, directory, ["rev-parse", "--is-inside-work-tree"]);
  return result.success && result.stdout.trim() === "true";
}

export async function getCurrentBranch(executor: CommandExecutor, directory: string): Promise<string> {
  const symbolicArgs = ["symbolic-ref", "--short", "HEAD"];
  const symbolicResult = await runGitCommand(executor, directory, symbolicArgs, { allowFailure: true });
  if (symbolicResult.success && symbolicResult.stdout.trim()) {
    return symbolicResult.stdout.trim();
  }

  const args = ["rev-parse", "--abbrev-ref", "HEAD"];
  const result = await runGitCommand(executor, directory, args);
  if (!result.success) {
    throw gitError("Failed to get current branch", result, args);
  }
  return result.stdout.trim();
}

export async function getLocalBranches(
  executor: CommandExecutor,
  directory: string
): Promise<{ name: string; current: boolean }[]> {
  const args = ["branch", "--format=%(refname:short)|%(HEAD)"];
  const result = await runGitCommand(executor, directory, args);
  if (!result.success) {
    throw gitError("Failed to get local branches", result, args);
  }

  const lines = result.stdout.replace(/\r\n?/g, "\n").trim().split("\n").filter(Boolean);
  const branches = lines.map((line) => {
    const [name, head] = line.split("|");
    return {
      name: name?.trim() ?? "",
      current: head?.trim() === "*",
    };
  }).filter((b) => b.name.length > 0);

  // Handle newly initialized repos with no commits.
  if (branches.length === 0) {
    const symbolicResult = await runGitCommand(executor, directory, ["symbolic-ref", "--short", "HEAD"]);
    if (symbolicResult.success && symbolicResult.stdout.trim()) {
      branches.push({ name: symbolicResult.stdout.trim(), current: true });
    }
  }

  branches.sort((a, b) => a.name.localeCompare(b.name));
  return branches;
}

export async function getDefaultBranch(executor: CommandExecutor, directory: string): Promise<string> {
  // Strategy 1: Try to get origin/HEAD reference
  const originHeadResult = await runGitCommand(
    executor,
    directory,
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    { allowFailure: true }
  );
  if (originHeadResult.success) {
    const ref = originHeadResult.stdout.trim();
    const match = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match?.[1]) {
      log.debug(`[GitService] Default branch from origin/HEAD: ${match[1]}`);
      return match[1];
    }
  }

  // Strategy 2: Check if 'main' branch exists locally
  const mainExists = await branchExists(executor, directory, "main");
  if (mainExists) {
    log.debug(`[GitService] Default branch: main (exists locally)`);
    return "main";
  }

  // Strategy 3: Check if 'master' branch exists locally
  const masterExists = await branchExists(executor, directory, "master");
  if (masterExists) {
    log.debug(`[GitService] Default branch: master (exists locally)`);
    return "master";
  }

  // Strategy 4: Fall back to current branch
  const currentBranch = await getCurrentBranch(executor, directory);
  log.debug(`[GitService] Default branch fallback to current: ${currentBranch}`);
  return currentBranch;
}

export async function verifyBranch(
  executor: CommandExecutor,
  directory: string,
  expectedBranch: string
): Promise<BranchVerificationResult> {
  const currentBranch = await getCurrentBranch(executor, directory);
  const matches = currentBranch === expectedBranch;

  if (!matches) {
    log.debug(`[GitService] Branch verification failed: expected '${expectedBranch}' but on '${currentBranch}'`);
  } else {
    log.debug(`[GitService] Branch verification passed: on '${currentBranch}'`);
  }

  return { matches, currentBranch, expectedBranch };
}

export async function hasUncommittedChanges(executor: CommandExecutor, directory: string): Promise<boolean> {
  const result = await runGitCommand(executor, directory, ["status", "--porcelain"]);
  if (!result.success) {
    throw gitError("Failed to check git status", result, ["status", "--porcelain"]);
  }
  const hasChanges = result.stdout.trim().length > 0;
  log.trace(`[GitService] hasUncommittedChanges: ${hasChanges}`);
  log.trace(`[GitService]   stdout length: ${result.stdout.length}`);
  log.trace(`[GitService]   stdout trimmed length: ${result.stdout.trim().length}`);
  if (hasChanges) {
    log.trace(`[GitService]   stdout (raw): ${JSON.stringify(result.stdout)}`);
    log.trace(`[GitService]   stdout (visible): "${result.stdout.trim()}"`);
  }
  return hasChanges;
}

export async function getChangedFiles(executor: CommandExecutor, directory: string): Promise<string[]> {
  const args = ["status", "--porcelain"];
  const result = await runGitCommand(executor, directory, args);
  if (!result.success) {
    throw gitError("Failed to get changed files", result, args);
  }

  const lines = result.stdout.replace(/\r\n/g, "\n").trimEnd().split("\n").filter(Boolean);
  return lines.map((line) => {
    const match = line.match(/^..\s+(.+?)(?:\s+->\s+(.+))?$/);
    if (match) {
      return match[2] ?? match[1] ?? line.slice(3).trim();
    }
    return line.slice(3).trim();
  });
}

export async function branchExists(
  executor: CommandExecutor,
  directory: string,
  branchName: string,
  options: { allowFailure?: boolean } = { allowFailure: true }
): Promise<boolean> {
  const result = await runGitCommand(
    executor,
    directory,
    ["rev-parse", "--verify", branchName],
    { allowFailure: options.allowFailure ?? true }
  );
  return result.success;
}

export async function hasStagedChanges(executor: CommandExecutor, directory: string): Promise<boolean> {
  const result = await runGitCommand(executor, directory, ["diff", "--cached", "--quiet"]);
  // Exit code 0 = no changes, 1 = changes exist
  return result.exitCode === 1;
}

export async function isAncestor(
  executor: CommandExecutor,
  directory: string,
  ancestorRef: string,
  descendantRef: string
): Promise<boolean> {
  const result = await runGitCommand(
    executor,
    directory,
    ["merge-base", "--is-ancestor", ancestorRef, descendantRef],
    { allowFailure: true }
  );
  return result.success;
}

export async function getConflictedFiles(executor: CommandExecutor, directory: string): Promise<string[]> {
  const result = await runGitCommand(
    executor,
    directory,
    ["diff", "--name-only", "--diff-filter=U"],
    { allowFailure: true }
  );

  if (!result.success || !result.stdout.trim()) return [];

  return result.stdout.replace(/\r\n/g, "\n").trim().split("\n").filter(Boolean);
}

// Re-export GitCommandResult for use in other git sub-modules
export type { GitCommandResult };
