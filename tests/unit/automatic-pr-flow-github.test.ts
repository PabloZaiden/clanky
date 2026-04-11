import { describe, expect, test } from "bun:test";
import type { CommandExecutor, CommandOptions, CommandResult } from "../../src/core/command-executor";
import type { PullRequestNavigationGitService } from "../../src/core/pull-request-navigation";
import {
  ensureAutomaticPrFlowPullRequest,
  fetchAutomaticPrFlowSnapshot,
  resolveAutomaticPrFlowReviewThread,
} from "../../src/core/automatic-pr-flow-github";
import { createLoopWithStatus } from "../frontend/helpers/factories";

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

  async getDefaultBranch(_directory: string): Promise<string> {
    return this.defaultBranch;
  }

  async getRemoteUrl(_directory: string, _remote = "origin"): Promise<string> {
    return this.remoteUrl;
  }
}

function createPushedLoop() {
  return createLoopWithStatus("pushed", {
    config: {
      name: "Automatic PR Flow",
      prompt: "Implement the automatic PR flow end to end.",
      baseBranch: "main",
    },
    state: {
      git: {
        originalBranch: "main",
        workingBranch: "feature/automatic-pr-flow",
        commits: [],
      },
    },
  });
}

describe("automatic PR flow GitHub helpers", () => {
  test("reuses an existing pull request when one already exists", async () => {
    const loop = createPushedLoop();
    const executor = new StubExecutor();
    const git = new StubGitService();

    executor.addResponse("gh", ["--version"], {
      success: true,
      stdout: "gh version 2.0.0",
      stderr: "",
      exitCode: 0,
    });
    executor.addResponse("gh", ["pr", "view", "feature/automatic-pr-flow", "--json", "number,url,state,mergedAt,reviewDecision"], {
      success: true,
      stdout: JSON.stringify({
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        state: "OPEN",
        reviewDecision: "REVIEW_REQUIRED",
      }),
      stderr: "",
      exitCode: 0,
    });

    const pullRequest = await ensureAutomaticPrFlowPullRequest(loop, "/tmp/repo", executor, git);

    expect(pullRequest).toEqual({
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      state: "OPEN",
      reviewDecision: "REVIEW_REQUIRED",
      mergedAt: undefined,
    });
  });

  test("creates a pull request when one does not exist yet", async () => {
    const loop = createPushedLoop();
    const executor = new StubExecutor();
    const git = new StubGitService();

    executor.addResponse("gh", ["--version"], {
      success: true,
      stdout: "gh version 2.0.0",
      stderr: "",
      exitCode: 0,
    });
    executor.addResponse("gh", ["pr", "view", "feature/automatic-pr-flow", "--json", "number,url,state,mergedAt,reviewDecision"], {
      success: false,
      stdout: "",
      stderr: "no pull requests found for branch \"feature/automatic-pr-flow\"",
      exitCode: 1,
    });
    executor.addResponse(
      "gh",
      [
        "pr",
        "create",
        "--base",
        "main",
        "--head",
        "feature/automatic-pr-flow",
        "--title",
        "Automatic PR Flow",
        "--body",
        "Automated pull request opened by Ralpher.\n\nLoop: Automatic PR Flow\n\nImplement the automatic PR flow end to end.",
      ],
      {
        success: true,
        stdout: "https://github.com/owner/repo/pull/42\n",
        stderr: "",
        exitCode: 0,
      },
    );

    executor.addResponse("gh", ["pr", "view", "feature/automatic-pr-flow", "--json", "number,url,state,mergedAt,reviewDecision"], {
      success: true,
      stdout: JSON.stringify({
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        state: "OPEN",
        reviewDecision: "REVIEW_REQUIRED",
      }),
      stderr: "",
      exitCode: 0,
    });

    const pullRequest = await ensureAutomaticPrFlowPullRequest(loop, "/tmp/repo", executor, git);

    expect(pullRequest.number).toBe(42);
    expect(pullRequest.url).toBe("https://github.com/owner/repo/pull/42");
  });

  test("normalizes review threads, PR comments, and reviews into actionable feedback", async () => {
    const executor = new StubExecutor();
    const git = new StubGitService();

    executor.addResponse("gh", ["--version"], {
      success: true,
      stdout: "gh version 2.0.0",
      stderr: "",
      exitCode: 0,
    });
    executor.addResponse(
      "gh",
      [
        "api",
        "graphql",
        "-f",
        "query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number url state reviewDecision reviewThreads(first:100){nodes{id isResolved isOutdated isCollapsed comments(first:20){nodes{id body createdAt url author{login} path originalLine}}} } comments(first:100){nodes{id body createdAt url author{login}}} reviews(first:100){nodes{id body state submittedAt url author{login}}}}}}",
        "-F",
        "owner=owner",
        "-F",
        "name=repo",
        "-F",
        "number=42",
      ],
      {
        success: true,
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                number: 42,
                url: "https://github.com/owner/repo/pull/42",
                state: "OPEN",
                reviewDecision: "CHANGES_REQUESTED",
                reviewThreads: {
                  nodes: [
                    {
                      id: "thread-1",
                      isResolved: false,
                      isOutdated: false,
                      comments: {
                        nodes: [
                          {
                            id: "comment-1",
                            body: "Please rename this helper.",
                            createdAt: "2026-04-11T04:00:00.000Z",
                            url: "https://github.com/owner/repo/pull/42#discussion_r1",
                            author: { login: "reviewer-a" },
                            path: "src/file.ts",
                            originalLine: 12,
                          },
                        ],
                      },
                    },
                    {
                      id: "thread-ignored",
                      isResolved: true,
                      isOutdated: false,
                      comments: { nodes: [] },
                    },
                  ],
                },
                comments: {
                  nodes: [
                    {
                      id: "pr-comment-1",
                      body: "Can you add a little more detail to the PR description?",
                      createdAt: "2026-04-11T04:01:00.000Z",
                      url: "https://github.com/owner/repo/pull/42#issuecomment-1",
                      author: { login: "reviewer-b" },
                    },
                  ],
                },
                reviews: {
                  nodes: [
                    {
                      id: "review-1",
                      body: "Needs another test for the error path.",
                      state: "CHANGES_REQUESTED",
                      submittedAt: "2026-04-11T04:02:00.000Z",
                      url: "https://github.com/owner/repo/pull/42#pullrequestreview-1",
                      author: { login: "reviewer-c" },
                    },
                    {
                      id: "review-ignored",
                      body: "Looks good to me.",
                      state: "APPROVED",
                      submittedAt: "2026-04-11T04:03:00.000Z",
                      url: "https://github.com/owner/repo/pull/42#pullrequestreview-2",
                      author: { login: "reviewer-d" },
                    },
                  ],
                },
              },
            },
          },
        }),
        stderr: "",
        exitCode: 0,
      },
    );

    const snapshot = await fetchAutomaticPrFlowSnapshot(
      {
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        state: "OPEN",
      },
      "/tmp/repo",
      executor,
      git,
    );

    expect(snapshot.reviewThreads).toEqual([
      {
        id: "thread-1",
        source: "review_thread",
        body: "Please rename this helper.",
        authorLogin: "reviewer-a",
        createdAt: "2026-04-11T04:00:00.000Z",
        url: "https://github.com/owner/repo/pull/42#discussion_r1",
        threadId: "thread-1",
        path: "src/file.ts",
        line: 12,
      },
    ]);
    expect(snapshot.reviewComments).toHaveLength(1);
    expect(snapshot.reviews).toHaveLength(1);
    expect(snapshot.actionableItems.map((item) => item.id)).toEqual([
      "thread-1",
      "pr-comment-1",
      "review-1",
    ]);
  });

  test("resolves review threads through gh graphql", async () => {
    const executor = new StubExecutor();

    executor.addResponse("gh", ["--version"], {
      success: true,
      stdout: "gh version 2.0.0",
      stderr: "",
      exitCode: 0,
    });
    executor.addResponse(
      "gh",
      [
        "api",
        "graphql",
        "-f",
        "query=mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}",
        "-F",
        "threadId=thread-1",
      ],
      {
        success: true,
        stdout: JSON.stringify({
          data: {
            resolveReviewThread: {
              thread: {
                id: "thread-1",
                isResolved: true,
              },
            },
          },
        }),
        stderr: "",
        exitCode: 0,
      },
    );

    await expect(resolveAutomaticPrFlowReviewThread("thread-1", "/tmp/repo", executor)).resolves.toBeUndefined();
  });
});
