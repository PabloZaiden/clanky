/**
 * Git remote operations: fetch, push, pull.
 */

import type { CommandExecutor } from "../command-executor";
import { log } from "@pablozaiden/webapp/server";
import { runGitCommand, gitError } from "./git-core";
import type { GitCommandResult } from "./git-types";
import { getCurrentBranch } from "./git-repo-query";

export interface RemoteBranchReference {
  remote: string;
  branch: string;
  ref: string;
}

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

export async function parseRemoteBranchReference(
  executor: CommandExecutor,
  directory: string,
  branchRef: string,
): Promise<RemoteBranchReference | null> {
  const args = ["remote"];
  const result = await runGitCommand(executor, directory, args);
  if (!result.success) {
    throw gitError("Failed to list Git remotes", result, args);
  }

  const remote = result.stdout
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && branchRef.startsWith(`${name}/`))
    .sort((left, right) => right.length - left.length)[0];
  if (remote) {
    const branch = branchRef.slice(remote.length + 1);
    return branch ? { remote, branch, ref: branchRef } : null;
  }

  const remoteRefArgs = [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/remotes",
  ];
  const remoteRefsResult = await runGitCommand(executor, directory, remoteRefArgs);
  if (!remoteRefsResult.success) {
    throw gitError("Failed to list remote-tracking branches", remoteRefsResult, remoteRefArgs);
  }
  const remoteRefs = remoteRefsResult.stdout
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((ref) => ref.trim());
  if (!remoteRefs.includes(branchRef)) {
    return null;
  }

  const separator = branchRef.indexOf("/");
  if (separator <= 0 || separator === branchRef.length - 1) {
    return null;
  }
  return {
    remote: branchRef.slice(0, separator),
    branch: branchRef.slice(separator + 1),
    ref: branchRef,
  };
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

/**
 * Git reports a missing remote ref through stderr rather than a dedicated
 * command error, so keep that wording compatibility at this boundary.
 */
function isMissingRemoteRefError(result: GitCommandResult): boolean {
  return !result.success &&
    result.exitCode === 128 &&
    result.stderr.includes("couldn't find remote ref");
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

  const fetchArgs = ["fetch", remote, branchName];
  const fetchResult = await runGitCommand(executor, directory, fetchArgs, {
    allowFailure: true,
  });
  if (!fetchResult.success) {
    if (isMissingRemoteRefError(fetchResult)) {
      log.debug(`[GitService] Remote branch '${branchName}' does not exist, skipping fetch`);
      return false;
    }
    throw gitError(`Failed to fetch ${remote}/${branchName}`, fetchResult, fetchArgs);
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

  const fetchArgs = ["fetch", remote, branch];
  const fetchResult = await runGitCommand(executor, directory, fetchArgs, {
    allowFailure: true,
  });
  if (!fetchResult.success) {
    if (isMissingRemoteRefError(fetchResult)) {
      log.debug(`[GitService] Remote branch '${branch}' does not exist, skipping pull`);
      return false;
    }
    throw gitError(`Failed to fetch ${remote}/${branch}`, fetchResult, fetchArgs);
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

export async function fetchRemoteBranches(
  executor: CommandExecutor,
  directory: string,
  remote: string,
): Promise<void> {
  const args = ["fetch", "--prune", remote];
  const result = await runGitCommand(executor, directory, args);
  if (!result.success) {
    throw gitError(`Failed to refresh remote branches from ${remote}`, result, args);
  }
}

export async function pullBranch(
  executor: CommandExecutor,
  directory: string,
  branchName: string,
  remote = "origin",
): Promise<void> {
  await getRemoteUrl(executor, directory, remote);

  await fetchRemoteBranches(executor, directory, remote);

  const mergeArgs = ["merge", "--ff-only", `${remote}/${branchName}`];
  const mergeResult = await runGitCommand(executor, directory, mergeArgs);
  if (!mergeResult.success) {
    throw gitError(`Failed to fast-forward merge ${remote}/${branchName}`, mergeResult, mergeArgs);
  }
}
