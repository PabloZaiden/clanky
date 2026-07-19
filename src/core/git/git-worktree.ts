/**
 * Git worktree operations.
 */

import type { CommandExecutor } from "../command-executor";
import { log } from "@pablozaiden/webapp/server";
import { runGitCommand, gitError } from "./git-core";
import { posix } from "node:path";
import { InvalidManagedWorktreePathError } from "./git-types";
import { PLANNING_DIRECTORY_NAME } from "../../lib/planning-files";

export const MANAGED_WORKTREE_DIRECTORY_NAME = ".clanky-worktrees";

function normalizeManagedPath(worktreePath: string): string {
  const normalizedPath = posix.normalize(worktreePath);
  return normalizedPath.length > 1
    ? normalizedPath.replace(/\/+$/, "")
    : normalizedPath;
}

export function normalizeManagedWorktreeIdentifier(identifier: string): string {
  const normalizedIdentifier = identifier.trim();
  if (
    normalizedIdentifier.length === 0
    || normalizedIdentifier === "."
    || normalizedIdentifier === ".."
    || normalizedIdentifier.includes("/")
    || normalizedIdentifier.includes("\\")
    || normalizedIdentifier.includes("\0")
  ) {
    throw new InvalidManagedWorktreePathError(
      identifier,
      "Managed worktree identifiers must be a non-empty, single safe path component",
    );
  }

  return normalizedIdentifier;
}

export function getManagedWorktreeRoot(repoDirectory: string): string {
  if (repoDirectory.length === 0 || repoDirectory.includes("\0")) {
    throw new InvalidManagedWorktreePathError(
      repoDirectory,
      "A repository directory is required to construct a managed worktree path",
    );
  }

  return normalizeManagedPath(posix.join(repoDirectory, MANAGED_WORKTREE_DIRECTORY_NAME));
}

export function getManagedWorktreePath(repoDirectory: string, identifier: string): string {
  return posix.join(
    getManagedWorktreeRoot(repoDirectory),
    normalizeManagedWorktreeIdentifier(identifier),
  );
}

export function isManagedWorktreePath(repoDirectory: string, worktreePath: string): boolean {
  if (
    repoDirectory.length === 0
    || repoDirectory.includes("\0")
    || worktreePath.length === 0
    || worktreePath.includes("\0")
  ) {
    return false;
  }

  const root = getManagedWorktreeRoot(repoDirectory);
  const normalizedPath = normalizeManagedPath(worktreePath);
  const rootPrefix = root === "/" ? "/" : `${root}/`;
  if (!normalizedPath.startsWith(rootPrefix)) {
    return false;
  }

  const identifier = normalizedPath.slice(rootPrefix.length);
  if (
    identifier.length === 0
    || identifier === "."
    || identifier === ".."
    || identifier.includes("/")
    || identifier.includes("\\")
    || identifier.trim() !== identifier
  ) {
    return false;
  }

  return normalizeManagedWorktreeIdentifier(identifier) === identifier;
}

export function assertManagedWorktreePath(repoDirectory: string, worktreePath: string): string {
  if (!isManagedWorktreePath(repoDirectory, worktreePath)) {
    throw new InvalidManagedWorktreePathError(
      worktreePath,
      `Managed worktree path must be a direct child of '${getManagedWorktreeRoot(repoDirectory)}'`,
    );
  }

  return normalizeManagedPath(worktreePath);
}

export function assertCanonicalManagedWorktreePath(
  repoDirectory: string,
  identifier: string,
  worktreePath: string,
): string {
  const canonicalPath = getManagedWorktreePath(repoDirectory, identifier);
  if (worktreePath !== canonicalPath) {
    throw new InvalidManagedWorktreePathError(
      worktreePath,
      `Managed worktree path must equal the canonical path '${canonicalPath}'`,
    );
  }

  return canonicalPath;
}

export async function createWorktree(
  executor: CommandExecutor,
  repoDirectory: string,
  worktreePath: string,
  branchName: string,
  baseBranch?: string
): Promise<void> {
  const managedWorktreePath = assertManagedWorktreePath(repoDirectory, worktreePath);
  await ensureWorktreeExcluded(executor, repoDirectory);

  await executor.exec("mkdir", ["-p", managedWorktreePath]);
  await executor.exec("rmdir", [managedWorktreePath]);

  let args = ["worktree", "add", managedWorktreePath, "-b", branchName];
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
        args = ["worktree", "add", "--orphan", "-b", branchName, managedWorktreePath];
      } else {
        args.push(baseBranch);
      }
    }
  }

  const result = await runGitCommand(executor, repoDirectory, args);
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
  const managedWorktreePath = assertManagedWorktreePath(repoDirectory, worktreePath);
  await ensureWorktreeExcluded(executor, repoDirectory);

  await executor.exec("mkdir", ["-p", managedWorktreePath]);
  await executor.exec("rmdir", [managedWorktreePath]);

  const args = ["worktree", "add", managedWorktreePath, branchName];
  const result = await runGitCommand(executor, repoDirectory, args);
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
  const managedWorktreePath = assertManagedWorktreePath(repoDirectory, worktreePath);
  const args = ["worktree", "remove", managedWorktreePath];
  if (options?.force) {
    args.push("--force");
  }

  const result = await runGitCommand(executor, repoDirectory, args);
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
  const managedWorktreePath = assertManagedWorktreePath(repoDirectory, worktreePath);
  const registeredBefore = await worktreeExists(executor, repoDirectory, managedWorktreePath);

  if (registeredBefore) {
    const args = ["worktree", "remove", managedWorktreePath];
    if (options?.force) {
      args.push("--force");
    }
    const result = await runGitCommand(executor, repoDirectory, args, { allowFailure: true });
    if (!result.success) {
      log.warn(`[GitService] Worktree removal command failed for ${managedWorktreePath}: ${result.stderr || result.stdout || "unknown error"}`);
    }
  }

  await pruneWorktrees(executor, repoDirectory);

  const registeredAfter = await worktreeExists(executor, repoDirectory, managedWorktreePath);
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
  const managedWorktreePath = assertManagedWorktreePath(repoDirectory, worktreePath);
  const worktrees = await listWorktrees(executor, repoDirectory);
  const comparablePaths = await getComparableWorktreePaths(executor, managedWorktreePath);
  return worktrees.some((wt) => comparablePaths.has(normalizeWorktreePath(wt.path)));
}

export async function ensureWorktreeExcluded(
  executor: CommandExecutor,
  repoDirectory: string
): Promise<void> {
  const excludePatterns = [MANAGED_WORKTREE_DIRECTORY_NAME, PLANNING_DIRECTORY_NAME];

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
  return posix.resolve(worktreePath).replace(/\/+$/, "");
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
    const parentPath = posix.dirname(existingParent);
    if (parentPath === existingParent) return null;
    existingParent = parentPath;
  }

  const canonicalParent = await resolveExistingDirectory(executor, existingParent);
  if (!canonicalParent) return null;

  const relativeSuffix = posix.relative(existingParent, normalizedPath);
  return normalizeWorktreePath(
    relativeSuffix ? posix.resolve(canonicalParent, relativeSuffix) : canonicalParent
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
