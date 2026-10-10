/**
 * Real Git fixtures used by black-box application journeys.
 */

import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { requireCommand } from "./process";

export interface GitFixture {
  repositoryDirectory: string;
  remoteDirectory: string;
  branch: string;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  return (await requireCommand(["git", ...args], { cwd })).stdout.trim();
}

export async function createGitFixture(rootDirectory: string): Promise<GitFixture> {
  const repositoryDirectory = join(rootDirectory, "repository");
  const remoteDirectory = join(rootDirectory, "remote.git");
  await mkdir(repositoryDirectory, { recursive: true });
  await git(repositoryDirectory, ["init"]);
  await git(repositoryDirectory, ["config", "user.email", "e2e@clanky.test"]);
  await git(repositoryDirectory, ["config", "user.name", "Clanky E2E"]);
  await Bun.write(join(repositoryDirectory, "README.md"), "# E2E fixture\n");
  await git(repositoryDirectory, ["add", "README.md"]);
  await git(repositoryDirectory, ["commit", "-m", "Initial fixture"]);
  await git(rootDirectory, ["init", "--bare", remoteDirectory]);
  await git(repositoryDirectory, ["remote", "add", "origin", remoteDirectory]);
  const branch = await git(repositoryDirectory, ["branch", "--show-current"]);
  await git(repositoryDirectory, ["push", "--set-upstream", "origin", branch]);
  return { repositoryDirectory, remoteDirectory, branch };
}

export async function readGitFile(fixture: GitFixture, relativePath: string): Promise<string> {
  return await Bun.file(join(fixture.repositoryDirectory, relativePath)).text();
}

export async function gitStatus(fixture: GitFixture): Promise<string> {
  return await git(fixture.repositoryDirectory, ["status", "--short"]);
}

export async function readGitBranchFile(
  fixture: GitFixture,
  branch: string,
  relativePath: string,
): Promise<string> {
  return await git(fixture.repositoryDirectory, ["show", `${branch}:${relativePath}`]);
}

export async function commitAndPushFile(
  fixture: GitFixture,
  relativePath: string,
  content: string,
): Promise<void> {
  await Bun.write(join(fixture.repositoryDirectory, relativePath), content);
  await git(fixture.repositoryDirectory, ["add", relativePath]);
  await git(fixture.repositoryDirectory, ["commit", "-m", `Update ${relativePath}`]);
  await git(fixture.repositoryDirectory, ["push", "origin", fixture.branch]);
}

export async function configureGitHubRemote(
  fixture: GitFixture,
): Promise<void> {
  const transportPath = join(
    fixture.repositoryDirectory,
    "..",
    "github-ssh-transport",
  );
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  await Bun.write(
    transportPath,
    [
      "#!/bin/sh",
      "command=",
      "for argument in \"$@\"; do command=$argument; done",
      "case \"$command\" in",
      `  "git-upload-pack 'e2e/clanky-fixture.git'") exec git-upload-pack ${quote(fixture.remoteDirectory)} ;;`,
      `  "git-receive-pack 'e2e/clanky-fixture.git'") exec git-receive-pack ${quote(fixture.remoteDirectory)} ;;`,
      "esac",
      "echo \"Unsupported GitHub Git transport command: $command\" >&2",
      "exit 2",
      "",
    ].join("\n"),
  );
  await chmod(transportPath, 0o700);
  await git(fixture.repositoryDirectory, [
    "config",
    "core.sshCommand",
    transportPath,
  ]);
  await git(fixture.repositoryDirectory, [
    "config",
    "ssh.variant",
    "ssh",
  ]);
  await git(fixture.repositoryDirectory, [
    "remote",
    "set-url",
    "origin",
    "git@github.com:e2e/clanky-fixture.git",
  ]);
}

export async function restoreLocalRemote(
  fixture: GitFixture,
): Promise<void> {
  await git(fixture.repositoryDirectory, [
    "remote",
    "set-url",
    "origin",
    fixture.remoteDirectory,
  ]);
  await git(fixture.repositoryDirectory, [
    "config",
    "--unset",
    "core.sshCommand",
  ]);
  await git(fixture.repositoryDirectory, [
    "config",
    "--unset",
    "ssh.variant",
  ]);
}

export async function readRemoteBranchFile(
  fixture: GitFixture,
  branch: string,
  relativePath: string,
): Promise<string> {
  const remoteBranch = branch.startsWith("origin/")
    ? branch.slice("origin/".length)
    : branch;
  return await git(fixture.repositoryDirectory, [
    "--git-dir",
    fixture.remoteDirectory,
    "show",
    `${remoteBranch}:${relativePath}`,
  ]);
}
