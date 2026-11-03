import { mkdir } from "node:fs/promises";
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
