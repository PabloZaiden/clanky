/**
 * Git worktree operations.
 */

import type { CommandExecutor } from "../command-executor";
import { log } from "@pablozaiden/webapp/server";
import { runGitCommand, gitError, resolveGitDirectory } from "./git-core";
import {
  dirnameExecutionPath,
  joinExecutionPath,
  normalizeExecutionPath,
  relativeExecutionPath,
  type ExecutionPathStyle,
} from "../execution-path";
import {
  MANAGED_WORKTREE_DIRECTORY_NAME,
  ManagedPathService,
  PLANNING_DIRECTORY_NAME,
} from "../managed-path-service";

function runWorktreeGitCommand(
  executor: CommandExecutor,
  directory: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
) {
  return runGitCommand(executor, directory, args, {
    ...options,
    scope: "managedWorktrees",
  });
}

export async function createWorktree(
  executor: CommandExecutor,
  repoDirectory: string,
  worktreePath: string,
  branchName: string,
  baseBranch?: string
): Promise<void> {
  const absoluteRepoDirectory = await resolveGitDirectory(executor, repoDirectory);
  const managedWorktreePath = new ManagedPathService(
    executor.pathStyle,
  ).assertManagedWorktreePath(absoluteRepoDirectory, worktreePath);
  await ensureWorktreeExcluded(executor, absoluteRepoDirectory);

  let args = ["worktree", "add", managedWorktreePath, "-b", branchName];
  if (baseBranch) {
    const baseBranchResult = await runWorktreeGitCommand(
      executor,
      absoluteRepoDirectory,
      ["rev-parse", "--verify", baseBranch],
      { allowFailure: true }
    );

    if (baseBranchResult.success) {
      args.push(baseBranch);
    } else {
      const currentBranchResult = await runWorktreeGitCommand(
        executor,
        absoluteRepoDirectory,
        ["symbolic-ref", "--short", "HEAD"],
        { allowFailure: true }
      );

      if (currentBranchResult.stdout.trim() === baseBranch) {
        args = ["worktree", "add", "--orphan", "-b", branchName, managedWorktreePath];
      } else {
        args.push(baseBranch);
      }
    }
  }

  const result = await runWorktreeGitCommand(executor, absoluteRepoDirectory, args);
  if (!result.success) {
    throw gitError(`Failed to create worktree at ${managedWorktreePath}`, result, args);
  }

  log.info(`[GitService] Created worktree at ${managedWorktreePath} with branch ${branchName}`);
}

export async function addWorktreeForExistingBranch(
  executor: CommandExecutor,
  repoDirectory: string,
  worktreePath: string,
  branchName: string
): Promise<void> {
  const absoluteRepoDirectory = await resolveGitDirectory(executor, repoDirectory);
  const managedWorktreePath = new ManagedPathService(
    executor.pathStyle,
  ).assertManagedWorktreePath(absoluteRepoDirectory, worktreePath);
  await ensureWorktreeExcluded(executor, absoluteRepoDirectory);

  const args = ["worktree", "add", managedWorktreePath, branchName];
  const result = await runWorktreeGitCommand(executor, absoluteRepoDirectory, args);
  if (!result.success) {
    throw gitError(`Failed to add worktree for branch ${branchName} at ${managedWorktreePath}`, result, args);
  }

  log.info(`[GitService] Added worktree at ${managedWorktreePath} for existing branch ${branchName}`);
}

export async function removeWorktree(
  executor: CommandExecutor,
  repoDirectory: string,
  worktreePath: string,
  options?: { force?: boolean }
): Promise<void> {
  const absoluteRepoDirectory = await resolveGitDirectory(executor, repoDirectory);
  const managedWorktreePath = new ManagedPathService(
    executor.pathStyle,
  ).assertManagedWorktreePath(absoluteRepoDirectory, worktreePath);
  const args = ["worktree", "remove", managedWorktreePath];
  if (options?.force) {
    args.push("--force");
  }

  const result = await runWorktreeGitCommand(executor, absoluteRepoDirectory, args);
  if (!result.success) {
    throw gitError(`Failed to remove worktree at ${managedWorktreePath}`, result, args);
  }

  log.info(`[GitService] Removed worktree at ${managedWorktreePath}`);
}

export async function ensureWorktreeRemoved(
  executor: CommandExecutor,
  repoDirectory: string,
  worktreePath: string,
  options?: { force?: boolean }
): Promise<void> {
  const absoluteRepoDirectory = await resolveGitDirectory(executor, repoDirectory);
  const managedWorktreePath = new ManagedPathService(
    executor.pathStyle,
  ).assertManagedWorktreePath(absoluteRepoDirectory, worktreePath);
  const registeredBefore = await worktreeExists(executor, absoluteRepoDirectory, managedWorktreePath);

  if (registeredBefore) {
    const args = ["worktree", "remove", managedWorktreePath];
    if (options?.force) {
      args.push("--force");
    }
    const result = await runWorktreeGitCommand(
      executor,
      absoluteRepoDirectory,
      args,
      { allowFailure: true },
    );
    if (!result.success) {
      log.warn(`[GitService] Worktree removal command failed for ${managedWorktreePath}: ${result.stderr || result.stdout || "unknown error"}`);
    }
  }

  await pruneWorktrees(executor, absoluteRepoDirectory);

  const registeredAfter = await worktreeExists(executor, absoluteRepoDirectory, managedWorktreePath);
  if (registeredAfter) {
    throw new Error(`Worktree is still registered after cleanup: ${managedWorktreePath}`);
  }

  if (await executor.directoryExists(managedWorktreePath)) {
    throw new Error(`Worktree directory still exists after cleanup: ${managedWorktreePath}`);
  }
}

export async function listWorktrees(
  executor: CommandExecutor,
  repoDirectory: string
): Promise<Array<{ path: string; head: string; branch: string }>> {
  const listArgs = ["worktree", "list", "--porcelain"];
  const result = await runWorktreeGitCommand(executor, repoDirectory, listArgs);
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
  const result = await runWorktreeGitCommand(executor, repoDirectory, pruneArgs);
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
  const absoluteRepoDirectory = await resolveGitDirectory(executor, repoDirectory);
  const managedWorktreePath = new ManagedPathService(
    executor.pathStyle,
  ).assertManagedWorktreePath(absoluteRepoDirectory, worktreePath);
  const worktrees = await listWorktrees(executor, absoluteRepoDirectory);
  const comparablePaths = await getComparableWorktreePaths(executor, managedWorktreePath);
  return worktrees.some((wt) => comparablePaths.has(
    worktreePathComparisonKey(wt.path, executor.pathStyle),
  ));
}

export async function ensureWorktreeExcluded(
  executor: CommandExecutor,
  repoDirectory: string
): Promise<void> {
  const absoluteRepoDirectory = await resolveGitDirectory(executor, repoDirectory);
  const excludePatterns = [MANAGED_WORKTREE_DIRECTORY_NAME, PLANNING_DIRECTORY_NAME];
  const result = await runWorktreeGitCommand(
    executor,
    absoluteRepoDirectory,
    ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
    { allowFailure: true },
  );
  const fallbackPath = joinExecutionPath(
    executor.pathStyle,
    absoluteRepoDirectory,
    ".git",
    "info",
    "exclude",
  );
  const resolvedPath = result.success ? result.stdout.trim() : "";
  const excludePath = resolvedPath
    ? normalizeExecutionPath(resolvedPath, executor.pathStyle)
    : fallbackPath;
  const content = await executor.readFile(excludePath);

  if (content !== null) {
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

    if (!(await executor.writeFile(excludePath, newContent))) {
      throw new Error(`Failed to update ${excludePath}`);
    }
    log.info(`[GitService] Added ${missingPatterns.join(", ")} to .git/info/exclude`);
    return;
  }

  log.debug(`[GitService] .git/info/exclude not found, creating it`);
  const initialContent = `# git ls-files --others --exclude-from=.git/info/exclude\n# Lines that start with '#' are comments.\n${excludePatterns.join("\n")}\n`;
  if (!(await executor.writeFile(excludePath, initialContent))) {
    throw new Error(`Failed to create ${excludePath}`);
  }
  log.info("[GitService] Created .git/info/exclude with Clanky-managed directory entries");
}

// ─── Path-comparison helpers (exported for use in GitService facade) ─────────

export function normalizeWorktreePath(
  worktreePath: string,
  pathStyle: ExecutionPathStyle,
): string {
  return normalizeExecutionPath(worktreePath, pathStyle);
}

export function worktreePathComparisonKey(
  worktreePath: string,
  pathStyle: ExecutionPathStyle,
): string {
  const normalizedPath = normalizeWorktreePath(worktreePath, pathStyle);
  return pathStyle === "windows" ? normalizedPath.toLowerCase() : normalizedPath;
}

export async function getComparableWorktreePaths(
  executor: CommandExecutor,
  worktreePath: string
): Promise<Set<string>> {
  const comparablePaths = new Set<string>([
    worktreePathComparisonKey(worktreePath, executor.pathStyle),
  ]);

  const canonicalPath = await resolvePathThroughExistingParent(executor, worktreePath);
  if (canonicalPath) {
    comparablePaths.add(worktreePathComparisonKey(canonicalPath, executor.pathStyle));
  }

  if (await executor.directoryExists(worktreePath)) {
    const cdupResult = await runWorktreeGitCommand(
      executor,
      worktreePath,
      ["rev-parse", "--show-cdup"],
      { allowFailure: true }
    );
    const isWorktreeRoot = cdupResult.success && cdupResult.stdout.trim() === "";
    if (!isWorktreeRoot) {
      return comparablePaths;
    }

    const result = await runWorktreeGitCommand(
      executor,
      worktreePath,
      ["rev-parse", "--show-toplevel"],
      { allowFailure: true }
    );
    const resolvedTopLevel = result.stdout.trim();
    if (result.success && resolvedTopLevel) {
      comparablePaths.add(
        worktreePathComparisonKey(resolvedTopLevel, executor.pathStyle),
      );
    }
  }

  return comparablePaths;
}

async function resolvePathThroughExistingParent(
  executor: CommandExecutor,
  worktreePath: string
): Promise<string | null> {
  const normalizedPath = normalizeWorktreePath(worktreePath, executor.pathStyle);
  let existingParent = normalizedPath;

  while (!(await executor.directoryExists(existingParent))) {
    const parentPath = dirnameExecutionPath(existingParent, executor.pathStyle);
    if (parentPath === existingParent) return null;
    existingParent = parentPath;
  }

  const canonicalParent = await resolveExistingDirectory(executor, existingParent);
  if (!canonicalParent) return null;

  const relativeSuffix = relativeExecutionPath(
    existingParent,
    normalizedPath,
    executor.pathStyle,
  );
  return relativeSuffix
    ? joinExecutionPath(executor.pathStyle, canonicalParent, relativeSuffix)
    : canonicalParent;
}

async function resolveExistingDirectory(
  executor: CommandExecutor,
  directory: string
): Promise<string | null> {
  const topLevelResult = await runWorktreeGitCommand(
    executor,
    directory,
    ["rev-parse", "--path-format=absolute", "--show-toplevel"],
    { allowFailure: true },
  );
  if (!topLevelResult.success || !topLevelResult.stdout.trim()) {
    log.debug(
      `[GitService] Failed to canonicalize directory ${directory}: ${topLevelResult.stderr || topLevelResult.stdout || "unknown error"}`
    );
    return null;
  }

  const prefixResult = await runWorktreeGitCommand(
    executor,
    directory,
    ["rev-parse", "--show-prefix"],
    { allowFailure: true },
  );
  if (!prefixResult.success) {
    log.debug(
      `[GitService] Failed to resolve repository-relative path for ${directory}: ${prefixResult.stderr || prefixResult.stdout || "unknown error"}`,
    );
    return null;
  }

  const topLevel = normalizeWorktreePath(
    topLevelResult.stdout.trim(),
    executor.pathStyle,
  );
  const prefix = prefixResult.stdout.trim();
  return prefix
    ? joinExecutionPath(executor.pathStyle, topLevel, prefix)
    : topLevel;
}
