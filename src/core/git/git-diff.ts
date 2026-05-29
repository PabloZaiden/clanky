/**
 * Git diff operations.
 */

import type { CommandExecutor } from "../command-executor";
import { runGitCommand, gitError } from "./git-core";
import type { FileDiff, FileDiffWithContent } from "./git-types";

export async function getDiff(
  executor: CommandExecutor,
  directory: string,
  baseBranch: string
): Promise<FileDiff[]> {
  const diffBase = await resolveDiffBaseRef(executor, directory, baseBranch);
  return getDiffForBase(executor, directory, diffBase);
}

async function getDiffForBase(
  executor: CommandExecutor,
  directory: string,
  diffBase: string
): Promise<FileDiff[]> {
  const numstatArgs = ["diff", "--numstat", diffBase];
  const result = await runGitCommand(executor, directory, numstatArgs);
  if (!result.success) {
    throw gitError("Failed to get diff", result, numstatArgs);
  }

  const statusResult = await runGitCommand(executor, directory, ["diff", "--name-status", diffBase]);

  const statusMap = new Map<string, string>();
  if (statusResult.success) {
    const statusLines = statusResult.stdout.replace(/\r\n/g, "\n").trim().split("\n").filter(Boolean);
    for (const line of statusLines) {
      const parts = line.split("\t");
      const statusChar = parts[0]?.charAt(0) ?? "M";
      const filePath = parts[parts.length - 1] ?? "";
      if (filePath) {
        statusMap.set(filePath, statusChar);
      }
    }
  }

  const lines = result.stdout.replace(/\r\n/g, "\n").trim().split("\n").filter(Boolean);
  const diffs: FileDiff[] = [];

  for (const line of lines) {
    const [additions, deletions, path] = line.split("\t");
    if (!path) continue;

    const statusChar = statusMap.get(path) ?? "M";
    let status: FileDiff["status"] = "modified";
    if (statusChar === "A") status = "added";
    else if (statusChar === "D") status = "deleted";
    else if (statusChar === "R") status = "renamed";

    diffs.push({
      path,
      status,
      additions: additions === "-" ? 0 : parseInt(additions ?? "0", 10),
      deletions: deletions === "-" ? 0 : parseInt(deletions ?? "0", 10),
    });
  }

  return diffs;
}

export async function getDiffSummary(
  executor: CommandExecutor,
  directory: string,
  baseBranch: string
): Promise<{ files: number; insertions: number; deletions: number }> {
  const diffBase = await resolveDiffBaseRef(executor, directory, baseBranch);
  const shortstatArgs = ["diff", "--shortstat", diffBase];
  const result = await runGitCommand(executor, directory, shortstatArgs);
  if (!result.success) {
    throw gitError("Failed to get diff summary", result, shortstatArgs);
  }

  const output = result.stdout.trim();
  if (!output) return { files: 0, insertions: 0, deletions: 0 };

  const filesMatch = output.match(/(\d+) files? changed/);
  const insertionsMatch = output.match(/(\d+) insertions?\(\+\)/);
  const deletionsMatch = output.match(/(\d+) deletions?\(-\)/);

  return {
    files: filesMatch?.[1] ? parseInt(filesMatch[1], 10) : 0,
    insertions: insertionsMatch?.[1] ? parseInt(insertionsMatch[1], 10) : 0,
    deletions: deletionsMatch?.[1] ? parseInt(deletionsMatch[1], 10) : 0,
  };
}

export async function getFileDiffContent(
  executor: CommandExecutor,
  directory: string,
  baseBranch: string,
  filePath: string
): Promise<string> {
  const diffBase = await resolveDiffBaseRef(executor, directory, baseBranch);
  const diffArgs = ["diff", diffBase, "--", filePath];
  const result = await runGitCommand(executor, directory, diffArgs);
  if (!result.success) {
    throw gitError("Failed to get file diff", result, diffArgs);
  }
  return result.stdout;
}

export async function getDiffWithContent(
  executor: CommandExecutor,
  directory: string,
  baseBranch: string
): Promise<FileDiffWithContent[]> {
  const diffBase = await resolveDiffBaseRef(executor, directory, baseBranch);
  const diffs = await getDiffForBase(executor, directory, diffBase);

  const result = await runGitCommand(executor, directory, ["diff", diffBase]);

  if (!result.success) {
    return diffs;
  }

  const fullDiff = result.stdout.replace(/\r\n/g, "\n");
  const diffsWithContent: FileDiffWithContent[] = [];

  const fileSections = fullDiff.split(/^diff --git /m).filter(Boolean);

  for (const diff of diffs) {
    const section = fileSections.find((s) => {
      const headerMatch = s.match(/^a\/(.+?) b\/(.+?)[\r\n]/);
      if (headerMatch) {
        return headerMatch[1] === diff.path || headerMatch[2] === diff.path;
      }
      return false;
    });

    diffsWithContent.push({
      ...diff,
      patch: section ? `diff --git ${section}` : undefined,
    });
  }

  return diffsWithContent;
}

async function resolveDiffBaseRef(
  executor: CommandExecutor,
  directory: string,
  baseBranch: string,
): Promise<string> {
  const verifyResult = await runGitCommand(
    executor,
    directory,
    ["rev-parse", "--verify", "--quiet", `${baseBranch}^{commit}`],
    { allowFailure: true },
  );
  if (verifyResult.success) {
    return baseBranch;
  }

  const localBranch = localBranchNameForRemoteRef(baseBranch);
  if (!localBranch) {
    return baseBranch;
  }

  const localVerifyResult = await runGitCommand(
    executor,
    directory,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${localBranch}^{commit}`],
    { allowFailure: true },
  );
  return localVerifyResult.success ? localBranch : baseBranch;
}

function localBranchNameForRemoteRef(ref: string): string | null {
  const fullRemoteMatch = ref.match(/^refs\/remotes\/[^/]+\/(.+)$/);
  if (fullRemoteMatch?.[1]) {
    return fullRemoteMatch[1];
  }

  const shortRemoteMatch = ref.match(/^origin\/(.+)$/);
  if (shortRemoteMatch?.[1]) {
    return shortRemoteMatch[1];
  }

  return null;
}
