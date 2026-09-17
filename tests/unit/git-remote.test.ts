import { describe, expect, test } from "bun:test";

import type { CommandOptions, CommandResult } from "../../src/core/command-executor";
import { GitService, GitCommandError } from "../../src/core/git";
import { TestCommandExecutor } from "../mocks/mock-executor";

class GitRemoteTestExecutor extends TestCommandExecutor {
  override readonly pathStyle = "posix";
  readonly calls: Array<{
    command: string;
    args: string[];
    options?: CommandOptions;
  }> = [];

  constructor(private readonly results: CommandResult[]) {
    super("/absolute/repository");
  }

  override async getEnvironmentVariable(_name: string): Promise<string | null> {
    return null;
  }

  override async exec(
    command: string,
    args: string[],
    options?: CommandOptions,
  ): Promise<CommandResult> {
    this.calls.push({ command, args, options });
    const result = this.results.shift();
    if (!result) {
      throw new Error("Git remote test executor ran out of command results");
    }
    return result;
  }
}

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    success: true,
    stdout: "",
    stderr: "",
    exitCode: 0,
    ...overrides,
  };
}

function createGit(results: CommandResult[]): GitService {
  return GitService.withExecutor(new GitRemoteTestExecutor(results));
}

describe("GitService remote ref classification", () => {
  test("skips fetch when the requested remote ref is missing", async () => {
    const git = createGit([
      commandResult({ stdout: "git@example.com:owner/repo.git\n" }),
      commandResult({
        success: false,
        stderr: "fatal: couldn't find remote ref 'feature'\n",
        exitCode: 128,
      }),
    ]);

    await expect(git.fetchBranch("/repo", "feature")).resolves.toBe(false);
  });

  test("skips pull when the requested remote ref is missing", async () => {
    const git = createGit([
      commandResult({ stdout: "git@example.com:owner/repo.git\n" }),
      commandResult({
        success: false,
        stderr: "fatal: couldn't find remote ref 'main'\n",
        exitCode: 128,
      }),
    ]);

    await expect(git.pull("/repo", "main")).resolves.toBe(false);
  });

  test("preserves structured errors for unrelated fetch failures", async () => {
    const stderr = "fatal: unable to access the remote repository\n";
    const git = createGit([
      commandResult({ stdout: "git@example.com:owner/repo.git\n" }),
      commandResult({
        success: false,
        stderr,
        exitCode: 7,
      }),
    ]);

    await expect(git.fetchBranch("/repo", "feature")).rejects.toMatchObject({
      code: "GIT_COMMAND_FAILED",
      command: "git fetch origin feature",
      exitCode: 7,
      gitStderr: stderr,
    } satisfies Partial<GitCommandError>);
  });

  test("retries host-key failures with Git metadata resolved from a relative repository", async () => {
    const executor = new GitRemoteTestExecutor([
      commandResult({
        success: false,
        stderr: "Host key verification failed.\n",
        exitCode: 128,
      }),
      commandResult({
        success: false,
        stderr: "",
        exitCode: 1,
      }),
      commandResult({ stdout: "/absolute/repository/.git/clanky-known-hosts\n" }),
      commandResult(),
    ]);
    const git = GitService.withExecutor(executor);

    await expect(git.pushBranch(
      "relative/repository",
      "feature",
    )).resolves.toBe("origin/feature");

    expect(executor.calls.at(-1)?.options?.env?.["GIT_SSH_COMMAND"]).toContain(
      "/absolute/repository/.git/clanky-known-hosts",
    );
    expect(executor.calls[1]?.options?.logFailures).toBe(false);
  });
});
