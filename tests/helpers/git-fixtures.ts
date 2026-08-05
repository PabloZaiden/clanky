/**
 * Shared git repository fixtures for tests that need real repositories.
 */

import { mkdtemp, mkdir, realpath, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";

export interface InitializeGitRepositoryOptions {
  initialBranch?: string;
  initialCommit?: "readme" | "empty" | "all" | "none";
  initialCommitMessage?: string;
  initialFiles?: Record<string, string>;
}

export interface CreateTempGitRepositoryOptions extends InitializeGitRepositoryOptions {
  prefix?: string;
  resolveRealpath?: boolean;
}

export interface CreateTempBareGitRepositoryOptions {
  prefix?: string;
  resolveRealpath?: boolean;
}

interface GitCommandResult {
  stdout: string;
  stderr: string;
}

export async function createTempGitRepository(
  options: CreateTempGitRepositoryOptions = {},
): Promise<string> {
  const {
    prefix = "clanky-git-test-",
    resolveRealpath = false,
    initialCommit = "readme",
  } = options;

  const tempDir = await mkdtemp(join(tmpdir(), prefix));
  const repoDir = resolveRealpath ? await realpath(tempDir) : tempDir;

  await initializeGitRepository(repoDir, { ...options, initialCommit });
  return repoDir;
}

export async function initializeGitRepository(
  directory: string,
  options: InitializeGitRepositoryOptions = {},
): Promise<string> {
  const {
    initialBranch,
    initialCommit = "all",
    initialCommitMessage = "Initial commit",
    initialFiles = {},
  } = options;

  const initArgs = initialBranch
    ? ["-c", `init.defaultBranch=${initialBranch}`, "init"]
    : ["init"];
  await runGit(directory, initArgs);
  await configureGitRepository(directory);

  for (const [path, content] of Object.entries(initialFiles)) {
    const filePath = join(directory, path);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);
  }

  if (initialCommit === "readme" && !Object.hasOwn(initialFiles, "README.md")) {
    await writeFile(join(directory, "README.md"), "# Test\n");
  }

  if (initialCommit === "readme" || initialCommit === "all") {
    await runGit(directory, ["add", "-A"]);
    await runGit(directory, ["commit", "--allow-empty", "-m", initialCommitMessage]);
  } else if (initialCommit === "empty") {
    await runGit(directory, ["commit", "--allow-empty", "-m", initialCommitMessage]);
  }

  return directory;
}

export async function configureGitRepository(directory: string): Promise<void> {
  await runGit(directory, ["config", "user.email", "test@test.com"]);
  await runGit(directory, ["config", "user.name", "Test User"]);
  await runGit(directory, ["config", "gc.auto", "0"]);
  await runGit(directory, ["config", "maintenance.auto", "false"]);
}

export async function createTempBareGitRepository(
  options: CreateTempBareGitRepositoryOptions = {},
): Promise<string> {
  const {
    prefix = "clanky-git-bare-test-",
    resolveRealpath = false,
  } = options;

  const tempDir = await mkdtemp(join(tmpdir(), prefix));
  const repoDir = resolveRealpath ? await realpath(tempDir) : tempDir;
  await runGit(repoDir, ["init", "--bare"]);
  return repoDir;
}

export async function getCurrentBranch(directory: string): Promise<string> {
  const result = await runGit(directory, ["branch", "--show-current"]);
  const branch = result.stdout.trim();
  if (!branch) {
    throw new Error(`Git repository at ${directory} is not on a checked-out branch`);
  }
  return branch;
}

export async function cleanupTempGitRepository(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

export async function runGit(directory: string, args: string[]): Promise<GitCommandResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed in ${directory}: ${stderr || stdout || `exit code ${exitCode}`}`,
    );
  }

  return { stdout, stderr };
}
