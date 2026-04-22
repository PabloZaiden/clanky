import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { CommandExecutor, CommandOptions, CommandResult } from "../../src/core/command-executor";
import type { PullRequestNavigationGitService } from "../../src/core/pull-request-navigation";
import {
  ensureAutomaticPrFlowPullRequest,
  fetchAutomaticPrFlowSnapshot,
  resolveAutomaticPrFlowReviewThread,
} from "../../src/core/automatic-pr-flow-github";
import { backendManager } from "../../src/core/backend-manager";
import { createLoopWithStatus, createModelInfo } from "../frontend/helpers/factories";
import { createMockBackend, MockAcpBackend } from "../mocks/mock-backend";

let testDataDir: string;

class StubExecutor implements CommandExecutor {
  private responses = new Map<string, CommandResult[]>();
  readonly calls: Array<{ command: string; args: string[] }> = [];

  addResponse(command: string, args: string[], result: CommandResult): void {
    const key = this.key(command, args);
    const existing = this.responses.get(key) ?? [];
    existing.push(result);
    this.responses.set(key, existing);
  }

  async exec(command: string, args: string[], _options?: CommandOptions): Promise<CommandResult> {
    this.calls.push({ command, args });
    const queued = this.responses.get(this.key(command, args));
    const next = queued?.shift();
    return next ?? {
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
  beforeEach(async () => {
    testDataDir = await mkdtemp(join(tmpdir(), "ralpher-automatic-pr-test-"));
    process.env["RALPHER_DATA_DIR"] = testDataDir;
    backendManager.resetForTesting();
    const { ensureDataDirectories, closeDatabase } = await import("../../src/persistence/database");
    closeDatabase();
    await ensureDataDirectories();
    const { createWorkspace } = await import("../../src/persistence/workspaces");
    const { getDefaultServerSettings } = await import("../../src/types/settings");
    await createWorkspace({
      id: "workspace-1",
      name: "Test Workspace",
      directory: "/workspaces/test-project",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      serverSettings: getDefaultServerSettings(),
    });
  });

  afterEach(async () => {
    backendManager.resetForTesting();
    const { closeDatabase } = await import("../../src/persistence/database");
    closeDatabase();
    delete process.env["RALPHER_DATA_DIR"];
    await rm(testDataDir, { recursive: true, force: true });
  });

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
    executor.addResponse("gh", ["pr", "view", "feature/automatic-pr-flow", "--json", "number,url,state,mergedAt,reviewDecision,mergeStateStatus"], {
      success: true,
      stdout: JSON.stringify({
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        state: "OPEN",
        reviewDecision: "REVIEW_REQUIRED",
        mergeStateStatus: "BEHIND",
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
      mergeStateStatus: "BEHIND",
      viewerCanUpdateBranch: undefined,
      mergedAt: undefined,
    });
  });

  test("creates a pull request when one does not exist yet", async () => {
    const loop = createPushedLoop();
    loop.state.git!.commits = [
      {
        iteration: 1,
        sha: "abc123",
        message: "feat(pr): generate PR metadata from actual changes",
        timestamp: "2026-04-11T04:00:00.000Z",
        filesChanged: 2,
      },
    ];
    const executor = new StubExecutor();
    const git = new StubGitService();
    backendManager.setBackendForTesting(createMockBackend([
      JSON.stringify({
        title: "Generate PR metadata from actual changes",
        body: "## Summary\n- Generate the PR title and description from commits and diff data.\n\n## Changes\n- Added metadata generation for automatic pull requests.",
      }),
    ]));

    executor.addResponse("gh", ["--version"], {
      success: true,
      stdout: "gh version 2.0.0",
      stderr: "",
      exitCode: 0,
    });
    executor.addResponse("gh", ["pr", "view", "feature/automatic-pr-flow", "--json", "number,url,state,mergedAt,reviewDecision,mergeStateStatus"], {
      success: false,
      stdout: "",
      stderr: "no pull requests found for branch \"feature/automatic-pr-flow\"",
      exitCode: 1,
    });
    executor.addResponse("git", ["-C", "/tmp/repo", "diff", "--numstat", "main"], {
      success: true,
      stdout: "12\t4\tsrc/core/automatic-pr-flow-github.ts\n3\t0\tsrc/core/pull-request-metadata.ts\n",
      stderr: "",
      exitCode: 0,
    });
    executor.addResponse("git", ["-C", "/tmp/repo", "diff", "--name-status", "main"], {
      success: true,
      stdout: "M\tsrc/core/automatic-pr-flow-github.ts\nA\tsrc/core/pull-request-metadata.ts\n",
      stderr: "",
      exitCode: 0,
    });
    executor.addResponse("git", ["-C", "/tmp/repo", "diff", "--shortstat", "main"], {
      success: true,
      stdout: " 2 files changed, 15 insertions(+), 4 deletions(-)\n",
      stderr: "",
      exitCode: 0,
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
        "Generate PR metadata from actual changes",
        "--body",
        "## Summary\n- Generate the PR title and description from commits and diff data.\n\n## Changes\n- Added metadata generation for automatic pull requests.",
      ],
      {
        success: true,
        stdout: "https://github.com/owner/repo/pull/42\n",
        stderr: "",
        exitCode: 0,
      },
    );

    executor.addResponse("gh", ["pr", "view", "feature/automatic-pr-flow", "--json", "number,url,state,mergedAt,reviewDecision,mergeStateStatus"], {
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
    const createCall = executor.calls.find((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "create");
    expect(createCall).toBeDefined();
    expect(createCall?.args).toContain("Generate PR metadata from actual changes");
    expect(createCall?.args.join("\n")).not.toContain("Ralpher");
  });

  test("uses the configured cheap model for PR metadata when it is available", async () => {
    const loop = createPushedLoop();
    loop.config.model = {
      providerID: "anthropic",
      modelID: "claude-sonnet",
      variant: "",
    };
    loop.config.cheapModel = {
      mode: "custom",
      model: {
        providerID: "openai",
        modelID: "gpt-4o-mini",
        variant: "fast",
      },
    };
    loop.state.git!.commits = [
      {
        iteration: 1,
        sha: "abc123",
        message: "feat(pr): generate helper metadata with cheap model",
        timestamp: "2026-04-11T04:00:00.000Z",
        filesChanged: 1,
      },
    ];

    const executor = new StubExecutor();
    const git = new StubGitService();
    const backend = new MockAcpBackend({
      responses: [
        JSON.stringify({
          title: "Use the helper model for metadata generation",
          body: "## Summary\n- Route PR metadata generation through the helper model.",
        }),
      ],
      models: [
        createModelInfo({
          providerID: "anthropic",
          modelID: "claude-sonnet",
          modelName: "Claude Sonnet",
          providerName: "Anthropic",
          connected: true,
        }),
        createModelInfo({
          providerID: "openai",
          modelID: "gpt-4o-mini",
          modelName: "GPT-4o Mini",
          providerName: "OpenAI",
          connected: true,
          variants: ["fast"],
        }),
      ],
    });
    let promptModel: { providerID: string; modelID: string; variant?: string } | undefined;
    const originalSendPrompt = backend.sendPrompt.bind(backend);
    backend.sendPrompt = async (sessionId, prompt) => {
      promptModel = prompt.model;
      return await originalSendPrompt(sessionId, prompt);
    };
    backendManager.setBackendForTesting(backend);

    executor.addResponse("gh", ["--version"], {
      success: true,
      stdout: "gh version 2.0.0",
      stderr: "",
      exitCode: 0,
    });
    executor.addResponse("gh", ["pr", "view", "feature/automatic-pr-flow", "--json", "number,url,state,mergedAt,reviewDecision,mergeStateStatus"], {
      success: false,
      stdout: "",
      stderr: "no pull requests found for branch \"feature/automatic-pr-flow\"",
      exitCode: 1,
    });
    executor.addResponse("git", ["-C", "/tmp/repo", "diff", "--numstat", "main"], {
      success: true,
      stdout: "1\t0\tsrc/core/automatic-pr-flow-github.ts\n",
      stderr: "",
      exitCode: 0,
    });
    executor.addResponse("git", ["-C", "/tmp/repo", "diff", "--name-status", "main"], {
      success: true,
      stdout: "M\tsrc/core/automatic-pr-flow-github.ts\n",
      stderr: "",
      exitCode: 0,
    });
    executor.addResponse("git", ["-C", "/tmp/repo", "diff", "--shortstat", "main"], {
      success: true,
      stdout: " 1 file changed, 1 insertion(+)\n",
      stderr: "",
      exitCode: 0,
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
        "Use the helper model for metadata generation",
        "--body",
        "## Summary\n- Route PR metadata generation through the helper model.",
      ],
      {
        success: true,
        stdout: "https://github.com/owner/repo/pull/42\n",
        stderr: "",
        exitCode: 0,
      },
    );
    executor.addResponse("gh", ["pr", "view", "feature/automatic-pr-flow", "--json", "number,url,state,mergedAt,reviewDecision,mergeStateStatus"], {
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

    await ensureAutomaticPrFlowPullRequest(loop, "/tmp/repo", executor, git);

    expect(promptModel).toEqual({
      providerID: "openai",
      modelID: "gpt-4o-mini",
      variant: "fast",
    });
  });

  test("falls back to deterministic non-branded metadata when AI output is unusable", async () => {
    const loop = createPushedLoop();
    loop.state.git!.commits = [
      {
        iteration: 1,
        sha: "abc123",
        message: "feat(pr): generate PR metadata from actual changes",
        timestamp: "2026-04-11T04:00:00.000Z",
        filesChanged: 2,
      },
      {
        iteration: 2,
        sha: "def456",
        message: "test(pr): cover PR metadata fallback behavior",
        timestamp: "2026-04-11T05:00:00.000Z",
        filesChanged: 1,
      },
    ];
    const executor = new StubExecutor();
    const git = new StubGitService();
    backendManager.setBackendForTesting(createMockBackend([
      JSON.stringify({
        title: "AutoPR by Ralpher",
        body: "Opened automatically by Ralpher.",
      }),
    ]));

    executor.addResponse("gh", ["--version"], {
      success: true,
      stdout: "gh version 2.0.0",
      stderr: "",
      exitCode: 0,
    });
    executor.addResponse("gh", ["pr", "view", "feature/automatic-pr-flow", "--json", "number,url,state,mergedAt,reviewDecision,mergeStateStatus"], {
      success: false,
      stdout: "",
      stderr: "no pull requests found for branch \"feature/automatic-pr-flow\"",
      exitCode: 1,
    });
    executor.addResponse("git", ["-C", "/tmp/repo", "diff", "--numstat", "main"], {
      success: true,
      stdout: "12\t4\tsrc/core/automatic-pr-flow-github.ts\n3\t0\ttests/unit/automatic-pr-flow-github.test.ts\n",
      stderr: "",
      exitCode: 0,
    });
    executor.addResponse("git", ["-C", "/tmp/repo", "diff", "--name-status", "main"], {
      success: true,
      stdout: "M\tsrc/core/automatic-pr-flow-github.ts\nM\ttests/unit/automatic-pr-flow-github.test.ts\n",
      stderr: "",
      exitCode: 0,
    });
    executor.addResponse("git", ["-C", "/tmp/repo", "diff", "--shortstat", "main"], {
      success: true,
      stdout: " 2 files changed, 15 insertions(+), 4 deletions(-)\n",
      stderr: "",
      exitCode: 0,
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
        "Generate PR metadata from actual changes and cover PR metadata fallback behavior",
        "--body",
        "## Summary\n- Generate PR metadata from actual changes\n- Cover PR metadata fallback behavior\n\n## Changes\n- 2 files changed\n- 15 insertions\n- 4 deletions\n\n## Files\n- src/core/automatic-pr-flow-github.ts (modified) (+12 / -4)\n- tests/unit/automatic-pr-flow-github.test.ts (modified) (+3)\n\n## Branches\n- Base: `main`\n- Head: `feature/automatic-pr-flow`",
      ],
      {
        success: true,
        stdout: "https://github.com/owner/repo/pull/42\n",
        stderr: "",
        exitCode: 0,
      },
    );
    executor.addResponse("gh", ["pr", "view", "feature/automatic-pr-flow", "--json", "number,url,state,mergedAt,reviewDecision,mergeStateStatus"], {
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
    const createCall = executor.calls.find((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "create");
    expect(createCall).toBeDefined();
    const createArgs = createCall?.args.join("\n") ?? "";
    expect(createArgs).toContain("Generate PR metadata from actual changes and cover PR metadata fallback behavior");
    expect(createArgs).not.toContain("Ralpher");
    expect(createArgs).not.toContain("AutoPR");
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
        "query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number url state reviewDecision mergeStateStatus viewerCanUpdateBranch reviewThreads(first:100){nodes{id isResolved isOutdated isCollapsed comments(first:20){nodes{id body createdAt url author{login} path originalLine}}} } comments(first:100){nodes{id body createdAt url author{login}}} reviews(first:100){nodes{id body state submittedAt url author{login}}}}}}",
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
                mergeStateStatus: "BEHIND",
                viewerCanUpdateBranch: true,
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
    expect(snapshot.pullRequest).toEqual({
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      state: "OPEN",
      reviewDecision: "CHANGES_REQUESTED",
      mergeStateStatus: "BEHIND",
      viewerCanUpdateBranch: true,
      mergedAt: undefined,
    });
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
