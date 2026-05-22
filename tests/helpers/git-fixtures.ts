/**
 * Shared git repository fixtures for tests that need real repositories.
 */

import { mkdtemp, realpath, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

interface CreateTempGitRepositoryOptions {
  prefix?: string;
  resolveRealpath?: boolean;
  initialCommit?: "readme" | "empty";
  initialBranch?: string;
  initialCommitMessage?: string;
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
    initialBranch,
    initialCommitMessage = "Initial commit",
  } = options;

  const tempDir = await mkdtemp(join(tmpdir(), prefix));
  const repoDir = resolveRealpath ? await realpath(tempDir) : tempDir;

  const initArgs = initialBranch
    ? ["-c", `init.defaultBranch=${initialBranch}`, "init"]
    : ["init"];
  await runGit(repoDir, initArgs);
  await runGit(repoDir, ["config", "user.email", "test@test.com"]);
  await runGit(repoDir, ["config", "user.name", "Test User"]);
  await runGit(repoDir, ["config", "gc.auto", "0"]);
  await runGit(repoDir, ["config", "maintenance.auto", "false"]);

  if (initialCommit === "readme") {
    await writeFile(join(repoDir, "README.md"), "# Test\n");
    await runGit(repoDir, ["add", "-A"]);
    await runGit(repoDir, ["commit", "-m", initialCommitMessage]);
  } else {
    await runGit(repoDir, ["commit", "--allow-empty", "-m", initialCommitMessage]);
  }

  return repoDir;
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
