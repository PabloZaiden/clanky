/**
 * Git worktree operations.
 */

import type { CommandExecutor } from "../command-executor";
import { log } from "../logger";
import { runGitCommand, gitError } from "./git-core";
import { dirname, relative, resolve } from "node:path";
import { PLANNING_DIRECTORY_NAME } from "../../lib/planning-files";

export async function createWorktree(
  executor: CommandExecutor,
  repoDirectory: string,
  worktreePath: string,
  branchName: string,
  baseBranch?: string
): Promise<void> {
  await ensureWorktreeExcluded(executor, repoDirectory);

  await executor.exec("mkdir", ["-p", worktreePath]);
  await executor.exec("rmdir", [worktreePath]);

  let args = ["worktree", "add", worktreePath, "-b", branchName];
  if (baseBranch) {
    const baseBranchResult = await runGitCommand(
      executor,
      repoDirectory,
      ["rev-parse", "--verify", baseBranch],
      { allowFailure: true }
    );

    if (baseBranchResult.success) {
      args.push(baseBranch);
    } else {
      const currentBranchResult = await runGitCommand(
        executor,
        repoDirectory,
        ["symbolic-ref", "--short", "HEAD"],
        { allowFailure: true }
      );

      if (currentBranchResult.stdout.trim() === baseBranch) {
        args = ["worktree", "add", "--orphan", "-b", branchName, worktreePath];
      } else {
        args.push(baseBranch);
      }
    }
  }

  const result = await runGitCommand(executor, repoDirectory, args);
  if (!result.success) {
    throw gitError(`Failed to create worktree at ${worktreePath}`, result, args);
  }

  log.info(`[GitService] Created worktree at ${worktreePath} with branch ${branchName}`);
}

export async function addWorktreeForExistingBranch(
  executor: CommandExecutor,
  repoDirectory: string,
  worktreePath: string,
  branchName: string
): Promise<void> {
  await ensureWorktreeExcluded(executor, repoDirectory);

  await executor.exec("mkdir", ["-p", worktreePath]);
  await executor.exec("rmdir", [worktreePath]);

  const args = ["worktree", "add", worktreePath, branchName];
  const result = await runGitCommand(executor, repoDirectory, args);
  if (!result.success) {
    throw gitError(`Failed to add worktree for branch ${branchName} at ${worktreePath}`, result, args);
  }

  log.info(`[GitService] Added worktree at ${worktreePath} for existing branch ${branchName}`);
}

export async function removeWorktree(
  executor: CommandExecutor,
  repoDirectory: string,
  worktreePath: string,
  options?: { force?: boolean }
): Promise<void> {
  const args = ["worktree", "remove", worktreePath];
  if (options?.force) {
    args.push("--force");
  }

  const result = await runGitCommand(executor, repoDirectory, args);
  if (!result.success) {
    throw gitError(`Failed to remove worktree at ${worktreePath}`, result, args);
  }

  log.info(`[GitService] Removed worktree at ${worktreePath}`);
}

export async function ensureWorktreeRemoved(
  executor: CommandExecutor,
  repoDirectory: string,
  worktreePath: string,
  options?: { force?: boolean }
): Promise<void> {
  const registeredBefore = await worktreeExists(executor, repoDirectory, worktreePath);

  if (registeredBefore) {
    const args = ["worktree", "remove", worktreePath];
    if (options?.force) {
      args.push("--force");
    }
    const result = await runGitCommand(executor, repoDirectory, args, { allowFailure: true });
    if (!result.success) {
      log.warn(`[GitService] Worktree removal command failed for ${worktreePath}: ${result.stderr || result.stdout || "unknown error"}`);
    }
  }

  await pruneWorktrees(executor, repoDirectory);

  const registeredAfter = await worktreeExists(executor, repoDirectory, worktreePath);
  if (registeredAfter) {
    throw new Error(`Worktree is still registered after cleanup: ${worktreePath}`);
  }

  if (await executor.directoryExists(worktreePath)) {
    throw new Error(`Worktree directory still exists after cleanup: ${worktreePath}`);
  }
}

export async function listWorktrees(
  executor: CommandExecutor,
  repoDirectory: string
): Promise<Array<{ path: string; head: string; branch: string }>> {
  const listArgs = ["worktree", "list", "--porcelain"];
  const result = await runGitCommand(executor, repoDirectory, listArgs);
  if (!result.success) {
    throw gitError("Failed to list worktrees", result, listArgs);
  }

  const output = result.stdout.replace(/\r\n/g, "\n").trim();
  if (!output) return [];

  const entries: Array<{ path: string; head: string; branch: string }> = [];
  const blocks = output.split("\n\n");

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    let path = "";
    let head = "";
    let branch = "";

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        path = line.substring("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        head = line.substring("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        const ref = line.substring("branch ".length);
        branch = ref.replace(/^refs\/heads\//, "");
      }
    }

    if (path) {
      entries.push({ path, head, branch });
    }
  }

  return entries;
}

export async function pruneWorktrees(executor: CommandExecutor, repoDirectory: string): Promise<void> {
  const pruneArgs = ["worktree", "prune"];
  const result = await runGitCommand(executor, repoDirectory, pruneArgs);
  if (!result.success) {
    throw gitError("Failed to prune worktrees", result, pruneArgs);
  }

  log.info(`[GitService] Pruned stale worktree entries in ${repoDirectory}`);
}

export async function worktreeExists(
  executor: CommandExecutor,
  repoDirectory: string,
  worktreePath: string
): Promise<boolean> {
  const worktrees = await listWorktrees(executor, repoDirectory);
  const comparablePaths = await getComparableWorktreePaths(executor, worktreePath);
  return worktrees.some((wt) => comparablePaths.has(normalizeWorktreePath(wt.path)));
}

export async function ensureWorktreeExcluded(
  executor: CommandExecutor,
  repoDirectory: string
): Promise<void> {
  const excludePatterns = [".clanky-worktrees", PLANNING_DIRECTORY_NAME];

  let excludePath: string;
  try {
    const result = await runGitCommand(executor, repoDirectory, ["rev-parse", "--git-path", "info/exclude"]);
    if (result.success && result.stdout.trim()) {
      const resolvedPath = result.stdout.trim();
      excludePath = resolvedPath.startsWith("/")
        ? resolvedPath
        : `${repoDirectory}/${resolvedPath}`;
    } else {
      excludePath = `${repoDirectory}/.git/info/exclude`;
    }
  } catch {
    excludePath = `${repoDirectory}/.git/info/exclude`;
  }

  const excludeDir = excludePath.substring(0, excludePath.lastIndexOf("/"));

  try {
    const content = await executor.readFile(excludePath);

    if (content === null) {
      throw new Error("File not found");
    }

    const lines = content.split("\n");
    const missingPatterns = excludePatterns.filter((pattern) => !lines.some(
      (line) => line.trim() === pattern || line.trim() === `${pattern}/`
    ));

    if (missingPatterns.length === 0) {
      log.debug("[GitService] Clanky-managed directories already in .git/info/exclude");
      return;
    }

    const appendedPatterns = `${missingPatterns.join("\n")}\n`;
    const newContent = content.endsWith("\n")
      ? `${content}${appendedPatterns}`
      : `${content}\n${appendedPatterns}`;

    await executor.exec("sh", ["-c", `cat > "${excludePath}" << 'EXCLUDE_EOF'\n${newContent}EXCLUDE_EOF`]);
    log.info(`[GitService] Added ${missingPatterns.join(", ")} to .git/info/exclude`);
  } catch {
    log.debug(`[GitService] .git/info/exclude not found, creating it`);
    await executor.exec("mkdir", ["-p", excludeDir]);
    const content = `# git ls-files --others --exclude-from=.git/info/exclude\n# Lines that start with '#' are comments.\n${excludePatterns.join("\n")}\n`;
    await executor.exec("sh", ["-c", `cat > "${excludePath}" << 'EXCLUDE_EOF'\n${content}EXCLUDE_EOF`]);
    log.info("[GitService] Created .git/info/exclude with Clanky-managed directory entries");
  }
}

// ─── Path-comparison helpers (exported for use in GitService facade) ─────────

export function normalizeWorktreePath(worktreePath: string): string {
  return resolve(worktreePath).replace(/\/+$/, "");
}

export async function getComparableWorktreePaths(
  executor: CommandExecutor,
  worktreePath: string
): Promise<Set<string>> {
  const comparablePaths = new Set<string>([normalizeWorktreePath(worktreePath)]);

  const canonicalPath = await resolvePathThroughExistingParent(executor, worktreePath);
  if (canonicalPath) {
    comparablePaths.add(canonicalPath);
  }

  if (await executor.directoryExists(worktreePath)) {
    const cdupResult = await runGitCommand(
      executor,
      worktreePath,
      ["rev-parse", "--show-cdup"],
      { allowFailure: true }
    );
    const isWorktreeRoot = cdupResult.success && cdupResult.stdout.trim() === "";
    if (!isWorktreeRoot) {
      return comparablePaths;
    }

    const result = await runGitCommand(
      executor,
      worktreePath,
      ["rev-parse", "--show-toplevel"],
      { allowFailure: true }
    );
    const resolvedTopLevel = result.stdout.trim();
    if (result.success && resolvedTopLevel) {
      comparablePaths.add(normalizeWorktreePath(resolvedTopLevel));
    }
  }

  return comparablePaths;
}

async function resolvePathThroughExistingParent(
  executor: CommandExecutor,
  worktreePath: string
): Promise<string | null> {
  const normalizedPath = normalizeWorktreePath(worktreePath);
  let existingParent = normalizedPath;

  while (!(await executor.directoryExists(existingParent))) {
    const parentPath = dirname(existingParent);
    if (parentPath === existingParent) return null;
    existingParent = parentPath;
  }

  const canonicalParent = await resolveExistingDirectory(executor, existingParent);
  if (!canonicalParent) return null;

  const relativeSuffix = relative(existingParent, normalizedPath);
  return normalizeWorktreePath(
    relativeSuffix ? resolve(canonicalParent, relativeSuffix) : canonicalParent
  );
}

async function resolveExistingDirectory(
  executor: CommandExecutor,
  directory: string
): Promise<string | null> {
  const result = await executor.exec("pwd", ["-P"], { cwd: directory });
  if (!result.success) {
    log.debug(
      `[GitService] Failed to canonicalize directory ${directory}: ${result.stderr || result.stdout || "unknown error"}`
    );
    return null;
  }

  const resolvedDirectory = result.stdout.trim();
  if (!resolvedDirectory) return null;

  return normalizeWorktreePath(resolvedDirectory);
}
