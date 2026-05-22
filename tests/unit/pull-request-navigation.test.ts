import { describe, expect, test } from "bun:test";
import type { CommandExecutor, CommandOptions, CommandResult } from "../../src/core/command-executor";
import {
  buildGitHubCompareUrl,
  normalizeGitHubRepositoryUrl,
  probePullRequestMonitoring,
  resolvePullRequestDestination,
  validateExistingPullRequestUrl,
  type PullRequestNavigationGitService,
} from "../../src/core/pull-request-navigation";
import { createTaskWithStatus } from "../frontend/helpers/factories";

class StubExecutor implements CommandExecutor {
  private responses = new Map<string, CommandResult>();

  addResponse(command: string, args: string[], result: CommandResult): void {
    this.responses.set(this.key(command, args), result);
  }

  async exec(command: string, args: string[], _options?: CommandOptions): Promise<CommandResult> {
    return this.responses.get(this.key(command, args)) ?? {
      success: false,
      stdout: "",
      stderr: `Unexpected command: ${command} ${args.join(" ")}`,
      exitCode: 1,
    };
  }

  async fileExists(_path: string): Promise<boolean> {
    return false;
  }

  async directoryExists(_path: string): Promise<boolean> {
    return false;
  }

  async readFile(_path: string): Promise<string | null> {
    return null;
  }

  async listDirectory(_path: string): Promise<string[]> {
    return [];
  }

  async writeFile(_path: string, _content: string): Promise<boolean> {
    return false;
  }

  private key(command: string, args: string[]): string {
    return `${command}\u0000${args.join("\u0000")}`;
  }
}

class StubGitService implements PullRequestNavigationGitService {
  remoteUrl = "git@github.com:owner/repo.git";
  defaultBranch = "main";
  defaultBranchCalls = 0;

  async getDefaultBranch(_directory: string): Promise<string> {
    this.defaultBranchCalls += 1;
    return this.defaultBranch;
  }

  async getRemoteUrl(_directory: string, _remote = "origin"): Promise<string> {
    return this.remoteUrl;
  }

  async hasRemote(_directory: string, _remote = "origin"): Promise<boolean> {
    return this.remoteUrl.trim().length > 0;
  }
}

describe("pull request navigation", () => {
  test("normalizes common GitHub remote formats", () => {
    expect(normalizeGitHubRepositoryUrl("git@github.com:owner/repo.git")).toBe("https://github.com/owner/repo");
    expect(normalizeGitHubRepositoryUrl("ssh://git@github.com/owner/repo.git")).toBe("https://github.com/owner/repo");
    expect(normalizeGitHubRepositoryUrl("https://github.com/owner/repo.git")).toBe("https://github.com/owner/repo");
    expect(normalizeGitHubRepositoryUrl("https://gitlab.com/owner/repo.git")).toBeNull();
  });

  test("builds a GitHub compare URL for PR creation", () => {
    expect(buildGitHubCompareUrl("https://github.com/owner/repo", "main", "feature/test")).toBe(
      "https://github.com/owner/repo/compare/main...feature%2Ftest?expand=1",
    );
  });

  test("validates existing GitHub pull request URLs", () => {
    expect(validateExistingPullRequestUrl("https://github.com/owner/repo/pull/42")).toBe(
      "https://github.com/owner/repo/pull/42",
    );
    expect(validateExistingPullRequestUrl("javascript:alert(1)")).toBeNull();
    expect(validateExistingPullRequestUrl("https://example.com/owner/repo/pull/42")).toBeNull();
    expect(validateExistingPullRequestUrl("https://github.com/owner/repo/issues/42")).toBeNull();
  });

  test("returns an existing PR URL when gh pr view succeeds for the task working branch", async () => {
    const task = createTaskWithStatus("pushed");
    const executor = new StubExecutor();
    const git = new StubGitService();
    const workingBranch = task.state.git?.workingBranch ?? "";

    executor.addResponse("gh", ["--version"], {
      success: true,
      stdout: "gh version 2.0.0",
      stderr: "",
      exitCode: 0,
    });
    executor.addResponse("gh", ["pr", "view", workingBranch, "--json", "url", "-q", ".url"], {
      success: true,
      stdout: "https://github.com/owner/repo/pull/42\n",
      stderr: "",
      exitCode: 0,
    });

    const destination = await resolvePullRequestDestination(task, "/tmp/repo", executor, git);

    expect(destination).toEqual({
      enabled: true,
      destinationType: "existing_pr",
      url: "https://github.com/owner/repo/pull/42",
    });
    expect(git.defaultBranchCalls).toBe(0);
  });

  test("builds a PR creation URL when gh is available but no PR exists yet", async () => {
    const task = createTaskWithStatus("pushed", {
      config: { baseBranch: "main" },
      state: {
        git: {
          originalBranch: "main",
          workingBranch: "feature/test-pr",
          commits: [],
        },
      },
    });
    const executor = new StubExecutor();
    const git = new StubGitService();

    executor.addResponse("gh", ["--version"], {
      success: true,
      stdout: "gh version 2.0.0",
      stderr: "",
      exitCode: 0,
    });
    executor.addResponse("gh", ["pr", "view", "feature/test-pr", "--json", "url", "-q", ".url"], {
      success: false,
      stdout: "",
      stderr: "no pull requests found for branch \"feature/test-pr\"",
      exitCode: 1,
    });

    const destination = await resolvePullRequestDestination(task, "/tmp/repo", executor, git);

    expect(destination).toEqual({
      enabled: true,
      destinationType: "create_pr",
      url: "https://github.com/owner/repo/compare/main...feature%2Ftest-pr?expand=1",
    });
    expect(git.defaultBranchCalls).toBe(0);
  });

  test("falls back to PR creation when gh returns an invalid URL", async () => {
    const task = createTaskWithStatus("pushed", {
      config: { baseBranch: "main" },
      state: {
        git: {
          originalBranch: "main",
          workingBranch: "feature/test-pr",
          commits: [],
        },
      },
    });
    const executor = new StubExecutor();
    const git = new StubGitService();

    executor.addResponse("gh", ["--version"], {
      success: true,
      stdout: "gh version 2.0.0",
      stderr: "",
      exitCode: 0,
    });
    executor.addResponse("gh", ["pr", "view", "feature/test-pr", "--json", "url", "-q", ".url"], {
      success: true,
      stdout: "not-a-valid-url\n",
      stderr: "",
      exitCode: 0,
    });

    const destination = await resolvePullRequestDestination(task, "/tmp/repo", executor, git);

    expect(destination).toEqual({
      enabled: true,
      destinationType: "create_pr",
      url: "https://github.com/owner/repo/compare/main...feature%2Ftest-pr?expand=1",
    });
  });

  test("disables PR navigation when gh is unavailable", async () => {
    const task = createTaskWithStatus("pushed");
    const executor = new StubExecutor();
    const git = new StubGitService();

    executor.addResponse("gh", ["--version"], {
      success: false,
      stdout: "",
      stderr: "gh: command not found",
      exitCode: 127,
    });

    const destination = await resolvePullRequestDestination(task, "/tmp/repo", executor, git);

    expect(destination).toEqual({
      enabled: false,
      destinationType: "disabled",
      disabledReason: "GitHub CLI is not available in the task environment.",
    });
  });

  test("falls back to the repository default branch when task base data is missing", async () => {
    const task = createTaskWithStatus("pushed", {
      config: { baseBranch: undefined },
      state: {
        git: {
          originalBranch: "",
          workingBranch: "feature/from-default",
          commits: [],
        },
      },
    });
    const executor = new StubExecutor();
    const git = new StubGitService();
    git.defaultBranch = "develop";

    executor.addResponse("gh", ["--version"], {
      success: true,
      stdout: "gh version 2.0.0",
      stderr: "",
      exitCode: 0,
    });
    executor.addResponse("gh", ["pr", "view", "feature/from-default", "--json", "url", "-q", ".url"], {
      success: false,
      stdout: "",
      stderr: "no pull requests found",
      exitCode: 1,
    });

    const destination = await resolvePullRequestDestination(task, "/tmp/repo", executor, git);

    expect(destination).toEqual({
      enabled: true,
      destinationType: "create_pr",
      url: "https://github.com/owner/repo/compare/develop...feature%2Ffrom-default?expand=1",
    });
    expect(git.defaultBranchCalls).toBe(1);
  });

  test("probePullRequestMonitoring returns merged when gh reports a merged PR", async () => {
    const task = createTaskWithStatus("pushed", {
      state: {
        git: {
          originalBranch: "main",
          workingBranch: "feature/test-pr",
          commits: [],
        },
      },
    });
    const executor = new StubExecutor();
    const git = new StubGitService();

    executor.addResponse("gh", ["--version"], {
      success: true,
      stdout: "gh version 2.0.0",
      stderr: "",
      exitCode: 0,
    });
    executor.addResponse("gh", ["pr", "view", "feature/test-pr", "--json", "number,url,state,mergedAt"], {
      success: true,
      stdout: JSON.stringify({
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        state: "MERGED",
        mergedAt: "2026-04-11T04:00:00.000Z",
      }),
      stderr: "",
      exitCode: 0,
    });

    const monitoring = await probePullRequestMonitoring(task, "/tmp/repo", executor, git);

    expect(monitoring).toEqual({
      status: "merged",
      lastCheckedAt: expect.any(String),
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/owner/repo/pull/42",
      mergedAt: "2026-04-11T04:00:00.000Z",
    });
  });

  test("probePullRequestMonitoring returns no_pr when gh reports no pull request", async () => {
    const task = createTaskWithStatus("pushed", {
      state: {
        git: {
          originalBranch: "main",
          workingBranch: "feature/no-pr",
          commits: [],
        },
      },
    });
    const executor = new StubExecutor();
    const git = new StubGitService();

    executor.addResponse("gh", ["--version"], {
      success: true,
      stdout: "gh version 2.0.0",
      stderr: "",
      exitCode: 0,
    });
    executor.addResponse("gh", ["pr", "view", "feature/no-pr", "--json", "number,url,state,mergedAt"], {
      success: false,
      stdout: "",
      stderr: "no pull requests found for branch \"feature/no-pr\"",
      exitCode: 1,
    });

    const monitoring = await probePullRequestMonitoring(task, "/tmp/repo", executor, git);

    expect(monitoring).toEqual({
      status: "no_pr",
      lastCheckedAt: expect.any(String),
    });
  });

  test("probePullRequestMonitoring returns unavailable for non-GitHub remotes", async () => {
    const task = createTaskWithStatus("pushed", {
      state: {
        git: {
          originalBranch: "main",
          workingBranch: "feature/non-github",
          commits: [],
        },
      },
    });
    const executor = new StubExecutor();
    const git = new StubGitService();
    git.remoteUrl = "git@gitlab.com:owner/repo.git";

    executor.addResponse("gh", ["--version"], {
      success: true,
      stdout: "gh version 2.0.0",
      stderr: "",
      exitCode: 0,
    });

    const monitoring = await probePullRequestMonitoring(task, "/tmp/repo", executor, git);

    expect(monitoring).toEqual({
      status: "unavailable",
      lastCheckedAt: expect.any(String),
      lastError: "Could not determine a GitHub origin remote for this task.",
    });
  });

  test("probePullRequestMonitoring returns an error when gh output is invalid", async () => {
    const task = createTaskWithStatus("pushed", {
      state: {
        git: {
          originalBranch: "main",
          workingBranch: "feature/bad-json",
          commits: [],
        },
      },
    });
    const executor = new StubExecutor();
    const git = new StubGitService();

    executor.addResponse("gh", ["--version"], {
      success: true,
      stdout: "gh version 2.0.0",
      stderr: "",
      exitCode: 0,
    });
    executor.addResponse("gh", ["pr", "view", "feature/bad-json", "--json", "number,url,state,mergedAt"], {
      success: true,
      stdout: "{not valid json",
      stderr: "",
      exitCode: 0,
    });

    const monitoring = await probePullRequestMonitoring(task, "/tmp/repo", executor, git);

    expect(monitoring).toEqual({
      status: "error",
      lastCheckedAt: expect.any(String),
      lastError: "GitHub CLI returned invalid pull request JSON.",
    });
  });
});
