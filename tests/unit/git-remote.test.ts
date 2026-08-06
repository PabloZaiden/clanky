import { describe, expect, test } from "bun:test";

import type { CommandOptions, CommandResult } from "../../src/core/command-executor";
import { GitService, GitCommandError } from "../../src/core/git";
import { TestCommandExecutor } from "../mocks/mock-executor";

class GitRemoteTestExecutor extends TestCommandExecutor {
  constructor(private readonly results: CommandResult[]) {
    super();
  }

  override async exec(
    _command: string,
    _args: string[],
    _options?: CommandOptions,
  ): Promise<CommandResult> {
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
});
