/**
 * Git remote operations: fetch, push, pull.
 */

import type { CommandExecutor } from "../command-executor";
import { log } from "../logger";
import { runGitCommand, gitError } from "./git-core";
import { getCurrentBranch } from "./git-repo-query";

export async function getRemoteUrl(
  executor: CommandExecutor,
  directory: string,
  remote = "origin"
): Promise<string> {
  const args = ["remote", "get-url", remote];
  const result = await runGitCommand(executor, directory, args);
  if (!result.success) {
    throw gitError(`Failed to get remote URL for ${remote}`, result, args);
  }
  return result.stdout.trim();
}

export async function hasRemote(
  executor: CommandExecutor,
  directory: string,
  remote = "origin",
): Promise<boolean> {
  const args = ["remote", "get-url", remote];
  const result = await runGitCommand(executor, directory, args, {
    allowFailure: true,
  });
  if (!result.success && !isMissingRemoteError(result.stderr, remote)) {
    log.error(`[GitService] Command failed: git ${args.join(" ")}`);
    log.error(`[GitService]   exitCode: ${result.exitCode}`);
    log.error(`[GitService]   stderr: ${result.stderr || "(empty)"}`);
    if (result.stdout) {
      log.error(`[GitService]   stdout: ${result.stdout.slice(0, 300)}${result.stdout.length > 300 ? "..." : ""}`);
    }
  }
  return result.success && result.stdout.trim().length > 0;
}

function isMissingRemoteError(stderr: string, remote: string): boolean {
  return stderr.includes(`No such remote '${remote}'`) || stderr.includes(`No such remote: ${remote}`);
}

export async function pushBranch(
  executor: CommandExecutor,
  directory: string,
  branchName: string,
  remote = "origin"
): Promise<string> {
  const pushArgs = ["push", "-u", remote, branchName];
  const result = await runGitCommand(executor, directory, pushArgs);
  if (!result.success) {
    throw gitError(`Failed to push branch ${branchName} to ${remote}`, result, pushArgs);
  }
  return `${remote}/${branchName}`;
}

export async function fetchBranch(
  executor: CommandExecutor,
  directory: string,
  branchName: string,
  remote = "origin"
): Promise<boolean> {
  if (!(await hasRemote(executor, directory, remote))) {
    log.debug(`[GitService] No remote '${remote}' configured, skipping fetch`);
    return false;
  }

  const fetchResult = await runGitCommand(executor, directory, ["fetch", remote, branchName]);
  if (!fetchResult.success) {
    if (
      fetchResult.stderr.includes("couldn't find remote ref") ||
      fetchResult.stderr.includes("fatal: couldn't find remote ref")
    ) {
      log.debug(`[GitService] Remote branch '${branchName}' does not exist, skipping fetch`);
      return false;
    }
    log.debug(`[GitService] Fetch failed: ${fetchResult.stderr}`);
    return false;
  }

  return true;
}

export async function pull(
  executor: CommandExecutor,
  directory: string,
  branchName?: string,
  remote = "origin"
): Promise<boolean> {
  if (!(await hasRemote(executor, directory, remote))) {
    log.debug(`[GitService] No remote '${remote}' configured, skipping pull`);
    return false;
  }

  const branch = branchName ?? (await getCurrentBranch(executor, directory));

  const fetchResult = await runGitCommand(executor, directory, ["fetch", remote, branch]);
  if (!fetchResult.success) {
    if (
      fetchResult.stderr.includes("couldn't find remote ref") ||
      fetchResult.stderr.includes("fatal: couldn't find remote ref")
    ) {
      log.debug(`[GitService] Remote branch '${branch}' does not exist, skipping pull`);
      return false;
    }
    log.debug(`[GitService] Fetch failed: ${fetchResult.stderr}`);
    return false;
  }

  const mergeResult = await runGitCommand(executor, directory, [
    "merge",
    "--ff-only",
    `${remote}/${branch}`,
  ]);

  if (!mergeResult.success) {
    log.debug(`[GitService] Fast-forward merge not possible for '${branch}': ${mergeResult.stderr}`);
    return false;
  }

  return true;
}

export async function pullBranch(
  executor: CommandExecutor,
  directory: string,
  branchName: string,
  remote = "origin",
): Promise<void> {
  await getRemoteUrl(executor, directory, remote);

  const fetchArgs = ["fetch", remote, branchName];
  const fetchResult = await runGitCommand(executor, directory, fetchArgs);
  if (!fetchResult.success) {
    throw gitError(`Failed to fetch ${remote}/${branchName}`, fetchResult, fetchArgs);
  }

  const mergeArgs = ["merge", "--ff-only", `${remote}/${branchName}`];
  const mergeResult = await runGitCommand(executor, directory, mergeArgs);
  if (!mergeResult.success) {
    throw gitError(`Failed to fast-forward merge ${remote}/${branchName}`, mergeResult, mergeArgs);
  }
}
