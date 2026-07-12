import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PushedTaskMonitor } from "../../src/core/pushed-task-monitor";
import { constructAutomaticPrReviewPrompt } from "../../src/core/task/task-review";
import {
  fetchAutomaticPrFlowSnapshot,
  type AutomaticPrFlowFeedbackItem,
  type AutomaticPrFlowPullRequest,
  type AutomaticPrFlowSnapshot,
} from "../../src/core/automatic-pr-flow-github";
import type { PullRequestNavigationGitService } from "../../src/core/pull-request-navigation";
import { SimpleEventEmitter } from "../../src/core/event-emitter";
import type { TaskEvent } from "../../src/types/events";
import {
  createInitialState,
  type Task,
} from "../../src/types/task";
import { TestCommandExecutor } from "../mocks/mock-executor";
import {
  setupTestContext,
  teardownTestContext,
  testModel,
  testWorkspaceId,
  type TestContext,
} from "../setup";

class GitHubSnapshotExecutor extends TestCommandExecutor {
  public readonly graphqlQueries: string[] = [];

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
      const query = args.find((argument) => argument.startsWith("query="));
      if (query) {
        this.graphqlQueries.push(query);
      }
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
  getDefaultBranch: async () => "main",
  getRemoteUrl: async () => "https://github.com/test-owner/test-repo.git",
  hasRemote: async () => true,
};

function createSnapshotPullRequest(headSha = "head-sha-1"): AutomaticPrFlowPullRequest {
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

function createTaskForMonitor(directory: string): Task {
  const now = new Date().toISOString();
  const state = createInitialState("automatic-pr-flow-task");
  state.status = "pushed";
  state.git = {
    originalBranch: "main",
    workingBranch: "feature/automatic-pr-flow",
    commits: [],
  };
  state.reviewMode = {
    addressable: true,
    completionAction: "push",
    reviewCycles: 0,
  };
  state.automaticPrFlow = {
    enabled: true,
    status: "monitoring",
    startedAt: now,
    updatedAt: now,
    lastCheckedAt: now,
    handledItems: [],
  };

  return {
    config: {
      id: state.id,
      name: "Automatic PR flow test",
      directory,
      prompt: "Test automatic PR feedback",
      createdAt: now,
      updatedAt: now,
      workspaceId: testWorkspaceId,
      model: testModel,
      maxIterations: Infinity,
      maxConsecutiveErrors: 10,
      activityTimeoutSeconds: null,
      stopPattern: "<promise>COMPLETE</promise>$",
      git: {
        branchPrefix: "",
        commitScope: "",
      },
      baseBranch: "main",
      useWorktree: false,
      clearPlanningFolder: false,
      planMode: false,
      autoAcceptPlan: false,
      fullyAutonomous: false,
      mode: "task",
    },
    state,
  };
}

function createSnapshot(
  pullRequest: AutomaticPrFlowPullRequest,
  sourceItems: AutomaticPrFlowFeedbackItem[],
): AutomaticPrFlowSnapshot {
  return {
    pullRequest,
    reviewThreads: sourceItems.filter((item) => item.source === "review_thread"),
    reviewComments: sourceItems.filter((item) => item.source === "review_comment"),
    reviews: sourceItems.filter((item) => item.source === "review"),
    workflowFailures: sourceItems.filter((item) => item.source === "workflow"),
    actionableItems: sourceItems,
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
                          workflowName: "CI",
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
                          workflowName: "CI",
                          status: "COMPLETED",
                          conclusion: "SUCCESS",
                        },
                        {
                          __typename: "CheckRun",
                          id: "check-pending",
                          name: "integration-tests",
                          workflowName: "CI",
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

    expect(executor.graphqlQueries[0]).toContain("statusCheckRollup");
    expect(executor.graphqlQueries[0]).toContain("headRefOid");
    expect(snapshot.workflowFailures).toHaveLength(2);
    expect(snapshot.actionableItems).toHaveLength(2);
    expect(snapshot.workflowFailures.map((item) => item.checkName)).toEqual([
      "unit-tests",
      "external-gate",
    ]);
    expect(snapshot.workflowFailures[0]?.id).toContain(headSha);
    expect(snapshot.workflowFailures[0]?.body).toContain("Expected true to be false");
    expect(snapshot.workflowFailures[0]?.url).toContain("/actions/runs/101");
  });

  test("processes mixed comments and workflow failures once, then resolves only review threads", async () => {
    const task = createTaskForMonitor(context.workDir);
    let currentTask = task;
    let snapshot = createSnapshot(createSnapshotPullRequest(), [
      {
        id: "thread-1",
        source: "review_thread",
        body: "Please handle the error path.",
        threadId: "thread-1",
      },
      {
        id: "workflow:check-failed:head-sha-1:FAILURE:2026-07-12T17:01:00Z",
        source: "workflow",
        body: "Workflow check unit-tests failed.",
        workflowName: "CI",
        checkName: "unit-tests",
        checkConclusion: "FAILURE",
        headSha: "head-sha-1",
      },
    ]);
    const startedBatches: Array<{
      batchId: string;
      sourceItems: AutomaticPrFlowFeedbackItem[];
    }> = [];
    const resolvedThreadIds: string[] = [];
    let pushCount = 0;

    const monitor = new PushedTaskMonitor({
      listTasks: async () => [currentTask],
      loadTask: async () => currentTask,
      updateTaskState: async (_taskId, state) => {
        currentTask = { ...currentTask, state };
        return true;
      },
      emitter: new SimpleEventEmitter<TaskEvent>(),
      getCommandExecutor: async () => new TestCommandExecutor(),
      createGitService: () => navigationGit,
      markMerged: async () => ({ success: true }),
      pushTask: async () => {
        pushCount++;
        currentTask = {
          ...currentTask,
          state: {
            ...currentTask.state,
            status: "pushed",
          },
        };
        return { success: true, syncStatus: "clean" };
      },
      updateBranch: async () => ({ success: true }),
      isTaskRunning: () => false,
      probePullRequestMonitoring: async () => ({
        status: "open",
        lastCheckedAt: new Date().toISOString(),
        pullRequestNumber: 42,
        pullRequestUrl: "https://github.com/test-owner/test-repo/pull/42",
      }),
      ensureAutomaticPrFlowPullRequest: async () => createSnapshotPullRequest(),
      fetchAutomaticPrFlowSnapshot: async () => snapshot,
      extractAutomaticPrFeedback: async (_task, _directory, items) => ({
        feedbackItems: items.map((item) => ({
          text: item.body,
          sourceItemIds: [item.id],
        })),
        ignoredItems: [],
      }),
      startAutomaticPrReviewCycle: async (_taskId, options) => {
        startedBatches.push({
          batchId: options.batchId,
          sourceItems: options.sourceItems,
        });
        return {
          success: true,
          reviewCycle: 1,
          branch: "feature/automatic-pr-flow",
        };
      },
      resolveAutomaticPrFlowReviewThread: async (threadId) => {
        resolvedThreadIds.push(threadId);
      },
      intervalMs: 60_000,
    });

    await monitor.runNow();

    expect(startedBatches).toHaveLength(1);
    expect(startedBatches[0]?.sourceItems.map((item) => item.source)).toEqual([
      "review_thread",
      "workflow",
    ]);
    expect(currentTask.state.automaticPrFlow?.activeBatch?.itemIds).toEqual([
      "thread-1",
      "workflow:check-failed:head-sha-1:FAILURE:2026-07-12T17:01:00Z",
    ]);

    currentTask = {
      ...currentTask,
      state: {
        ...currentTask.state,
        status: "completed",
      },
    };
    await monitor.runNow();

    expect(pushCount).toBe(1);
    expect(resolvedThreadIds).toEqual(["thread-1"]);
    expect(currentTask.state.automaticPrFlow?.activeBatch).toBeUndefined();
    expect(currentTask.state.automaticPrFlow?.handledItems).toEqual([
      {
        id: "thread-1",
        source: "review_thread",
        outcome: "resolved",
        handledAt: expect.any(String),
      },
      {
        id: "workflow:check-failed:head-sha-1:FAILURE:2026-07-12T17:01:00Z",
        source: "workflow",
        outcome: "manual",
        handledAt: expect.any(String),
      },
    ]);

    await monitor.runNow();
    expect(startedBatches).toHaveLength(1);

    snapshot = createSnapshot(createSnapshotPullRequest("head-sha-2"), [
      {
        id: "workflow:check-failed:head-sha-2:FAILURE:2026-07-12T17:05:00Z",
        source: "workflow",
        body: "The rerun failed on the new head.",
        workflowName: "CI",
        checkName: "unit-tests",
        checkConclusion: "FAILURE",
        headSha: "head-sha-2",
      },
    ]);
    await monitor.runNow();

    expect(startedBatches).toHaveLength(2);
  });

  test("includes workflow context in the automatic review prompt", () => {
    const workflowItem: AutomaticPrFlowFeedbackItem = {
      id: "workflow:check-failed:head-sha-1:FAILURE:2026-07-12T17:01:00Z",
      source: "workflow",
      body: "Workflow check unit-tests failed.",
      workflowName: "CI",
      checkName: "unit-tests",
      checkConclusion: "FAILURE",
      headSha: "head-sha-1",
      url: "https://github.com/test-owner/test-repo/actions/runs/101",
    };

    const prompt = constructAutomaticPrReviewPrompt(
      [{ text: workflowItem.body, sourceItemIds: [workflowItem.id] }],
      [workflowItem],
    );

    expect(prompt).toContain("failed workflow/check results");
    expect(prompt).toContain("workflows=CI");
    expect(prompt).toContain("checks=unit-tests");
    expect(prompt).toContain("conclusions=FAILURE");
    expect(prompt).toContain("headShas=head-sha-1");
  });
});
