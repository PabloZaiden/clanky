import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  fetchAutomaticPrFlowSnapshot,
  type AutomaticPrFlowPullRequest,
} from "../../src/core/automatic-pr-flow-github";
import type { PullRequestNavigationGitService } from "../../src/core/pull-request-navigation";
import { TestCommandExecutor } from "../mocks/mock-executor";
import {
  setupTestContext,
  teardownTestContext,
  type TestContext,
} from "../setup";

class GitHubSnapshotExecutor extends TestCommandExecutor {
  constructor(private readonly response: unknown) {
    super();
  }

  override async exec(
    command: string,
    args: string[],
    options?: Parameters<TestCommandExecutor["exec"]>[2],
  ) {
    if (command !== "gh") {
      return super.exec(command, args, options);
    }

    if (args[0] === "--version") {
      return {
        success: true,
        stdout: "gh version 2.65.0\n",
        stderr: "",
        exitCode: 0,
      };
    }

    if (args[0] === "api" && args[1] === "graphql") {
      return {
        success: true,
        stdout: JSON.stringify(this.response),
        stderr: "",
        exitCode: 0,
      };
    }

    return {
      success: false,
      stdout: "",
      stderr: `Unsupported gh command: ${args.join(" ")}`,
      exitCode: 1,
    };
  }
}

const navigationGit: PullRequestNavigationGitService = {
  getDefaultBranch: async () => "fixture-default",
  getRemoteUrl: async () => "https://github.com/test-owner/test-repo.git",
  hasRemote: async () => true,
};

function createSnapshotPullRequest(headSha: string): AutomaticPrFlowPullRequest {
  return {
    number: 42,
    url: "https://github.com/test-owner/test-repo/pull/42",
    state: "OPEN",
    reviewDecision: "REVIEW_REQUIRED",
    mergeStateStatus: "CLEAN",
    viewerCanUpdateBranch: false,
    headSha,
  };
}

describe("Automatic PR flow feedback sources", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await setupTestContext();
  });

  afterEach(async () => {
    await teardownTestContext(context);
  });

  test("extracts only failed checks from the current pull request head", async () => {
    const headSha = "head-sha-1";
    const executor = new GitHubSnapshotExecutor({
      data: {
        repository: {
          pullRequest: {
            number: 42,
            url: "https://github.com/test-owner/test-repo/pull/42",
            state: "OPEN",
            reviewDecision: "REVIEW_REQUIRED",
            mergeStateStatus: "CLEAN",
            viewerCanUpdateBranch: false,
            headRefOid: headSha,
            commits: {
              nodes: [{
                commit: {
                  oid: headSha,
                  statusCheckRollup: {
                    contexts: {
                      nodes: [
                        {
                          __typename: "CheckRun",
                          id: "check-failed",
                          databaseId: 101,
                          name: "unit-tests",
                          checkSuite: {
                            workflowRun: {
                              workflow: {
                                name: "CI",
                              },
                            },
                          },
                          status: "COMPLETED",
                          conclusion: "FAILURE",
                          detailsUrl: "https://github.com/test-owner/test-repo/actions/runs/101",
                          summary: "One test failed",
                          text: "Expected true to be false",
                          startedAt: "2026-07-12T17:00:00Z",
                          completedAt: "2026-07-12T17:01:00Z",
                        },
                        {
                          __typename: "CheckRun",
                          id: "check-success",
                          name: "lint",
                          checkSuite: {
                            workflowRun: {
                              workflow: {
                                name: "CI",
                              },
                            },
                          },
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                        },
                        {
                          __typename: "CheckRun",
                          id: "check-pending",
                          name: "integration-tests",
                          checkSuite: {
                            workflowRun: {
                              workflow: {
                                name: "CI",
                              },
                            },
                          },
                          status: "IN_PROGRESS",
                          conclusion: null,
                        },
                        {
                          __typename: "StatusContext",
                          id: "status-failure",
                          context: "external-gate",
                          state: "FAILURE",
                          description: "The external gate failed",
                          targetUrl: "https://example.test/gate",
                          createdAt: "2026-07-12T17:00:00Z",
                          updatedAt: "2026-07-12T17:02:00Z",
                        },
                      ],
                    },
                  },
                },
              }],
            },
            reviewThreads: { nodes: [] },
            comments: { nodes: [] },
            reviews: { nodes: [] },
          },
        },
      },
    });

    const snapshot = await fetchAutomaticPrFlowSnapshot(
      createSnapshotPullRequest(headSha),
      context.workDir,
      executor,
      navigationGit,
    );

    expect(snapshot.pullRequest.headSha).toBe(headSha);
    expect(snapshot.workflowFailures).toHaveLength(2);
    expect(snapshot.actionableItems).toHaveLength(2);
    expect(snapshot.workflowFailures.map((item) => item.checkName)).toEqual([
      "unit-tests",
      "external-gate",
    ]);
    expect(snapshot.workflowFailures.map((item) => item.headSha)).toEqual([
      headSha,
      headSha,
    ]);
    expect(snapshot.workflowFailures.map((item) => item.checkConclusion)).toEqual([
      "FAILURE",
      "FAILURE",
    ]);
  });
});
