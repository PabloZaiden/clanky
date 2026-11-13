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
  if (!diffBase) {
    return [];
  }
  return getDiffForBase(executor, directory, diffBase);
}

async function getDiffForBase(
  executor: CommandExecutor,
  directory: string,
  diffBase: string
): Promise<FileDiff[]> {
  const args = ["diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--raw", "--numstat", "-z", diffBase, "--"];
  const result = await runGitCommand(executor, directory, args);
  if (!result.success) {
    throw gitError("Failed to get diff", result, args);
  }

  const entries = result.stdout.split("\0");
  const diffs: Array<Omit<FileDiff, "additions" | "deletions">> = [];
  let index = 0;
  while (entries[index]?.startsWith(":")) {
    const header = entries[index++]!;
    const change = header.slice(header.lastIndexOf(" ") + 1).charAt(0);
    const sourcePath = entries[index++];
    const path = change === "R" || change === "C" ? entries[index++] : sourcePath;
    if (!path) throw new Error("Git returned an invalid changed-file record.");
    diffs.push({
      path,
      status: change === "A" || change === "C" ? "added"
        : change === "D" ? "deleted" : change === "R" ? "renamed" : "modified",
      ...(change === "R" ? { oldPath: sourcePath } : {}),
    });
  }
  const stats = parseNullDelimitedNumstat(entries.slice(index).join("\0"));
  return diffs.map((file) => {
    const counts = stats.get(file.path);
    if (!counts) throw new Error("Git returned a changed file without its statistics.");
    return { ...file, ...counts };
  });
}

function parseNullDelimitedNumstat(output: string): Map<string, { additions: number; deletions: number }> {
  const entries = output.split("\0");
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (let index = 0; index < entries.length - 1;) {
    const entry = entries[index++]!;
    const firstTab = entry.indexOf("\t");
    const secondTab = entry.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) continue;
    let path = entry.slice(secondTab + 1);
    if (!path) {
      index++;
      path = entries[index++] ?? "";
    }
    stats.set(path, {
      additions: Number.parseInt(entry.slice(0, firstTab), 10) || 0,
      deletions: Number.parseInt(entry.slice(firstTab + 1, secondTab), 10) || 0,
    });
  }
  return stats;
}

async function getWorkingTreeDiffBase(
  executor: CommandExecutor,
  directory: string,
  baseBranch: string,
): Promise<{ repository: string; base: string; baseRef: string }> {
  const rootArgs = ["rev-parse", "--show-toplevel"];
  const root = await runGitCommand(executor, directory, rootArgs);
  if (!root.success) throw gitError("Failed to locate the repository", root, rootArgs);
  const repository = root.stdout.trim();
  let baseRef: string;
  let base: string;
  const headArgs = ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"];
  const head = await runGitCommand(executor, repository, headArgs, { allowFailure: true });
  if (head.success) {
    const resolved = await resolveDiffBaseRef(executor, repository, baseBranch);
    if (!resolved) throw new Error(`The comparison branch '${baseBranch}' is unavailable.`);
    baseRef = resolved;
    const baseArgs = ["merge-base", "HEAD", baseRef];
    const mergeBase = await runGitCommand(executor, repository, baseArgs);
    if (!mergeBase.success || !mergeBase.stdout.trim()) {
      throw gitError("Failed to determine the branch comparison base", mergeBase, baseArgs);
    }
    base = mergeBase.stdout.trim();
  } else {
    const symbolic = await runGitCommand(executor, repository, ["symbolic-ref", "--quiet", "HEAD"], { allowFailure: true });
    const ref = symbolic.success
      ? await runGitCommand(executor, repository, ["show-ref", "--verify", "--quiet", symbolic.stdout.trim()], { allowFailure: true })
      : undefined;
    if (ref?.exitCode !== 1) throw gitError("The repository HEAD could not be read", head, headArgs);
    // hash-object without -w computes the empty tree without writing an object or index.
    const emptyArgs = ["hash-object", "-t", "tree", "--", "/dev/null"];
    const empty = await runGitCommand(executor, repository, emptyArgs);
    if (!empty.success) throw gitError("Failed to compare the initial files", empty, emptyArgs);
    base = empty.stdout.trim();
    baseRef = "empty tree";
  }
  return { repository, base, baseRef };
}

export async function getWorkingTreeDiff(
  executor: CommandExecutor,
  directory: string,
  baseBranch: string,
): Promise<{ files: FileDiff[]; base: string; baseRef: string }> {
  const { repository, base, baseRef } = await getWorkingTreeDiffBase(executor, directory, baseBranch);
  const files = await getDiffForBase(executor, repository, base);
  const untrackedArgs = ["ls-files", "--others", "--exclude-standard", "-z"];
  const untracked = await runGitCommand(executor, repository, untrackedArgs);
  if (!untracked.success) throw gitError("Failed to read untracked files", untracked, untrackedArgs);
  for (const path of untracked.stdout.split("\0").filter(Boolean)) {
    files.push({ path, status: "added", additions: null, deletions: null });
  }
  return { files, base, baseRef };
}

export async function getWorkingTreeFileDiff(
  executor: CommandExecutor,
  directory: string,
  base: string,
  path: string,
) {
  const rootArgs = ["rev-parse", "--show-toplevel"];
  const root = await runGitCommand(executor, directory, rootArgs);
  if (!root.success) throw gitError("Failed to locate the repository", root, rootArgs);
  const repository = root.stdout.trim();
  const tracked = (await getDiffForBase(executor, repository, base)).find((file) => file.path === path);
  if (!tracked) {
    const args = ["ls-files", "--others", "--exclude-standard", "-z"];
    const untracked = await runGitCommand(executor, repository, args);
    if (!untracked.success) throw gitError("Failed to read untracked files", untracked, args);
    if (!untracked.stdout.split("\0").includes(path)) return null;
  }
  const args = [
    "--literal-pathspecs", "diff",
    ...(!tracked ? ["--no-index"] : ["--find-renames"]),
    "--no-ext-diff", "--no-textconv", "--no-color", "--numstat", "--patch", "-z",
    ...(tracked ? [base] : []), "--",
    ...(!tracked ? ["/dev/null"] : []), path, ...(tracked?.oldPath ? [tracked.oldPath] : []),
  ];
  const result = await runGitCommand(executor, repository, args, { allowFailure: !tracked });
  if (!result.success && !(!tracked && result.exitCode === 1)) {
    throw gitError("Failed to read the file patch", result, args);
  }
  const stats = parseNullDelimitedNumstat(result.stdout).get(path);
  if (!stats) throw new Error("The file changed while its patch was being read; refresh the change list.");
  return {
    ...(tracked ?? { path, status: "added" as const }), ...stats,
    patch: result.stdout.slice(result.stdout.lastIndexOf("\0") + 1),
  };
}

export async function getDiffSummary(
  executor: CommandExecutor,
  directory: string,
  baseBranch: string
): Promise<{ files: number; insertions: number; deletions: number }> {
  const diffBase = await resolveDiffBaseRef(executor, directory, baseBranch);
  if (!diffBase) {
    return { files: 0, insertions: 0, deletions: 0 };
  }
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
  if (!diffBase) {
    return "";
  }
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
  if (!diffBase) {
    return [];
  }
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
): Promise<string | null> {
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
    return null;
  }

  const localVerifyResult = await runGitCommand(
    executor,
    directory,
    ["rev-parse", "--verify", "--quiet", `refs/heads/${localBranch}^{commit}`],
    { allowFailure: true },
  );
  return localVerifyResult.success ? localBranch : null;
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
