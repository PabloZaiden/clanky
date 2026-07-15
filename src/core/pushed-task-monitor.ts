/**
 * Background monitor for pushed tasks waiting on external pull request merges.
 */

import type { AutomaticPrFlowHandledItem, Task } from "@/shared/task";
import type { CommandExecutor } from "./command-executor";
import type { PullRequestNavigationGitService } from "./pull-request-navigation";
import type { TaskEvent } from "@/shared/events";
import type {
  AutomaticPrFlowFeedbackItem,
  AutomaticPrFlowPullRequest,
  AutomaticPrFlowSnapshot,
} from "./automatic-pr-flow-github";
import type { AutomaticPrFlowExtractedFeedbackItem, AutomaticPrFlowFeedbackExtractionResult } from "./automatic-pr-feedback";
import type { PushTaskResult, SendFollowUpResult, TaskResult } from "./task-manager";
import { listTasks, loadTask, updateTaskState } from "../persistence/tasks";
import { backendManager } from "./backend-manager";
import { taskEventEmitter, SimpleEventEmitter } from "./event-emitter";
import { GitService } from "./git";
import { createLogger } from "./logger";
import { getTaskWorkingDirectory, taskManager } from "./task-manager";
import { emitAutomaticPrFlowUpdatedEvent } from "./task/task-automatic-pr-flow-events";
import { probePullRequestMonitoring } from "./pull-request-navigation";
import {
  AUTOMATIC_PR_WORKFLOW_FAILURE_MESSAGE,
  ensureAutomaticPrFlowPullRequest,
  fetchAutomaticPrFlowSnapshot,
  resolveAutomaticPrFlowReviewThread,
} from "./automatic-pr-flow-github";
import { extractAutomaticPrFeedback } from "./automatic-pr-feedback";
import { runForEachActiveUser } from "./background-users";

const log = createLogger("core:pushed-task-monitor");

const DEFAULT_MONITOR_INTERVAL_MS = 5 * 60 * 1000;
const MINIMUM_MONITOR_INTERVAL_MS = 60 * 1000;
const MAX_AUTOMATIC_PR_FLOW_HANDLED_ITEMS = 200;

function mergeHandledItems(
  existingItems: AutomaticPrFlowHandledItem[],
  newItems: AutomaticPrFlowHandledItem[],
): AutomaticPrFlowHandledItem[] {
  const itemsById = new Map(existingItems.map((item) => [item.id, item]));
  for (const item of newItems) {
    itemsById.delete(item.id);
    itemsById.set(item.id, item);
  }
  return [...itemsById.values()].slice(-MAX_AUTOMATIC_PR_FLOW_HANDLED_ITEMS);
}

function getMonitorIntervalMs(): number {
  const rawValue = process.env["CLANKY_PUSHED_TASK_MONITOR_INTERVAL_MS"];
  if (!rawValue) {
    return DEFAULT_MONITOR_INTERVAL_MS;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsedValue) || parsedValue < MINIMUM_MONITOR_INTERVAL_MS) {
    log.warn("Invalid pushed task monitor interval, using default", {
      rawValue,
      minimumMs: MINIMUM_MONITOR_INTERVAL_MS,
      defaultMs: DEFAULT_MONITOR_INTERVAL_MS,
    });
    return DEFAULT_MONITOR_INTERVAL_MS;
  }

  return parsedValue;
}

function isEligibleForMonitoring(task: Task): boolean {
  if (task.state.reviewMode?.addressable !== true) {
    return false;
  }

  if (task.state.status === "pushed") {
    return true;
  }

  return task.state.automaticPrFlow?.enabled === true && task.state.automaticPrFlow.activeBatch !== undefined;
}

export interface PushedTaskMonitorDependencies {
  listTasks: () => Promise<Task[]>;
  loadTask: (taskId: string) => Promise<Task | null>;
  updateTaskState: (taskId: string, state: Task["state"]) => Promise<boolean>;
  emitter: SimpleEventEmitter<TaskEvent>;
  getCommandExecutor: (workspaceId: string, directory: string) => Promise<CommandExecutor>;
  createGitService: (executor: CommandExecutor) => PullRequestNavigationGitService;
  markMerged: (taskId: string) => Promise<TaskResult>;
  pushTask: (taskId: string) => Promise<PushTaskResult>;
  updateBranch: (taskId: string) => Promise<PushTaskResult>;
  isTaskRunning: (taskId: string) => boolean;
  probePullRequestMonitoring: (
    task: Task,
    directory: string,
    executor: CommandExecutor,
    git: PullRequestNavigationGitService,
  ) => Promise<NonNullable<Task["state"]["pullRequestMonitoring"]>>;
  ensureAutomaticPrFlowPullRequest: (
    task: Task,
    directory: string,
    executor: CommandExecutor,
    git: PullRequestNavigationGitService,
  ) => Promise<AutomaticPrFlowPullRequest>;
  fetchAutomaticPrFlowSnapshot: (
    pullRequest: AutomaticPrFlowPullRequest,
    directory: string,
    executor: CommandExecutor,
    git: PullRequestNavigationGitService,
  ) => Promise<AutomaticPrFlowSnapshot>;
  extractAutomaticPrFeedback: (
    task: Task,
    directory: string,
    feedbackItems: AutomaticPrFlowFeedbackItem[],
  ) => Promise<AutomaticPrFlowFeedbackExtractionResult>;
  startAutomaticPrReviewCycle: (
    taskId: string,
    options: {
      batchId: string;
      sourceItems: AutomaticPrFlowFeedbackItem[];
      feedbackItems: AutomaticPrFlowExtractedFeedbackItem[];
    },
  ) => Promise<SendFollowUpResult>;
  resolveAutomaticPrFlowReviewThread: (
    threadId: string,
    directory: string,
    executor: CommandExecutor,
  ) => Promise<void>;
  intervalMs: number;
}

export class PushedTaskMonitor {
  private readonly deps: PushedTaskMonitorDependencies;
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private isRunning = false;

  constructor(dependencies?: Partial<PushedTaskMonitorDependencies>) {
    this.deps = {
      listTasks,
      loadTask,
      updateTaskState,
      emitter: taskEventEmitter,
      getCommandExecutor: (workspaceId: string, directory: string) =>
        backendManager.getCommandExecutorAsync(workspaceId, directory),
      createGitService: (executor: CommandExecutor) => GitService.withExecutor(executor),
      markMerged: (taskId: string) => taskManager.markMerged(taskId),
      pushTask: (taskId: string) => taskManager.pushTask(taskId),
      updateBranch: (taskId: string) => taskManager.updateBranch(taskId),
      isTaskRunning: (taskId: string) => taskManager.isRunning(taskId),
      probePullRequestMonitoring,
      ensureAutomaticPrFlowPullRequest,
      fetchAutomaticPrFlowSnapshot,
      extractAutomaticPrFeedback,
      startAutomaticPrReviewCycle: (taskId: string, options) => taskManager.startAutomaticPrReviewCycle(taskId, options),
      resolveAutomaticPrFlowReviewThread,
      intervalMs: getMonitorIntervalMs(),
      ...dependencies,
    };
  }

  start(): void {
    if (this.intervalId !== undefined) {
      return;
    }

    log.info("Starting pushed task monitor", {
      intervalMs: this.deps.intervalMs,
    });
    this.intervalId = setInterval(() => {
      void this.runNow();
    }, this.deps.intervalMs);

    void this.runNow();
  }

  stop(_closeActiveConnections?: boolean): void {
    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  async runNow(): Promise<void> {
    if (this.isRunning) {
      log.debug("Skipping pushed task monitor run because a previous run is still active");
      return;
    }

    this.isRunning = true;
    try {
      await runForEachActiveUser(async () => {
        const tasks = await this.deps.listTasks();
        for (const task of tasks) {
          if (!isEligibleForMonitoring(task)) {
            continue;
          }
          await this.monitorTask(task);
        }
      });
    } catch (error) {
      log.error("Pushed task monitor run failed", {
        error: String(error),
      });
    } finally {
      this.isRunning = false;
    }
  }

  private async monitorTask(task: Task): Promise<void> {
    const automaticPrFlowEnabled = task.state.automaticPrFlow?.enabled === true;
    const workingDirectory = getTaskWorkingDirectory(task);
    if (!workingDirectory) {
      const now = new Date().toISOString();
      await this.persistTaskMonitoringState(
        task.config.id,
        {
          status: "error",
          lastCheckedAt: now,
          lastError: "Task is configured to use a worktree, but no worktree path is available.",
        },
        automaticPrFlowEnabled
          ? this.buildAutomaticPrFlowErrorState(task.state.automaticPrFlow, now, "Task is configured to use a worktree, but no worktree path is available.")
          : undefined,
      );
      return;
    }

    try {
      const executor = await this.deps.getCommandExecutor(task.config.workspaceId, workingDirectory);
      const git = this.deps.createGitService(executor);
      let monitoringState = await this.deps.probePullRequestMonitoring(task, workingDirectory, executor, git);
      let automaticPrFlowState: Task["state"]["automaticPrFlow"];

      if (automaticPrFlowEnabled) {
        try {
          const automaticPrFlowResult = await this.monitorAutomaticPrFlow(task, workingDirectory, executor, git);
          automaticPrFlowState = automaticPrFlowResult.automaticPrFlowState;
          monitoringState = automaticPrFlowResult.monitoringState ?? monitoringState;
        } catch (error) {
          automaticPrFlowState = this.buildAutomaticPrFlowErrorState(
            task.state.automaticPrFlow,
            new Date().toISOString(),
            String(error),
          );
        }
      }

      await this.persistTaskMonitoringState(task.config.id, monitoringState, automaticPrFlowState);

      if (monitoringState.status === "merged") {
        const latestTask = await this.deps.loadTask(task.config.id);
        if (latestTask?.state.status !== "pushed" || latestTask.state.reviewMode?.addressable !== true) {
          return;
        }

        const result = await this.deps.markMerged(task.config.id);
        if (!result.success) {
          log.warn("Failed to auto-mark task as merged after merged PR detection", {
            taskId: task.config.id,
            error: result.error.message,
          });
        }
      }
    } catch (error) {
      log.error("Failed to monitor pushed task", {
        taskId: task.config.id,
        error: String(error),
      });
      const now = new Date().toISOString();
      await this.persistTaskMonitoringState(
        task.config.id,
        {
          status: "error",
          lastCheckedAt: now,
          lastError: String(error),
        },
        automaticPrFlowEnabled
          ? this.buildAutomaticPrFlowErrorState(task.state.automaticPrFlow, now, String(error))
          : undefined,
      );
    }
  }

  private async monitorAutomaticPrFlow(
    task: Task,
    workingDirectory: string,
    executor: CommandExecutor,
    git: PullRequestNavigationGitService,
  ): Promise<{
    automaticPrFlowState: NonNullable<Task["state"]["automaticPrFlow"]>;
    monitoringState?: NonNullable<Task["state"]["pullRequestMonitoring"]>;
  }> {
    const previousState = task.state.automaticPrFlow;
    if (!previousState?.enabled) {
      throw new Error("Automatic PR flow is not enabled for this task.");
    }

    const now = new Date().toISOString();
    const handledItems = Array.isArray(previousState.handledItems)
      ? previousState.handledItems.slice(-MAX_AUTOMATIC_PR_FLOW_HANDLED_ITEMS)
      : [];
    const pullRequest = await this.deps.ensureAutomaticPrFlowPullRequest(task, workingDirectory, executor, git);
    const activeBatchStatus = previousState.activeBatch ? this.getAutomaticPrFlowBatchStatus(task) : undefined;
    const baseState: NonNullable<Task["state"]["automaticPrFlow"]> = {
      enabled: true,
      status: activeBatchStatus === "finalizing_feedback" ? "finalizing_feedback" : previousState.activeBatch ? "processing_feedback" : "monitoring",
      startedAt: previousState.startedAt,
      updatedAt: now,
      lastCheckedAt: now,
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.url,
      activeBatch: previousState.activeBatch,
      handledItems,
      stoppedAt: undefined,
    };

    if (previousState.activeBatch) {
      if (activeBatchStatus === "processing_feedback" || activeBatchStatus === "finalizing_feedback") {
        return {
          automaticPrFlowState: {
            ...baseState,
            status: activeBatchStatus,
          },
          monitoringState: this.mergeMonitoringStateFromPullRequest(task.state.pullRequestMonitoring, pullRequest, now),
        };
      }

      if (task.state.status === "completed") {
        const finalizeResult = await this.deps.pushTask(task.config.id);
        if (!finalizeResult.success) {
          throw finalizeResult.error;
        }

        if (finalizeResult.syncStatus === "conflicts_being_resolved") {
          return {
            automaticPrFlowState: {
              ...baseState,
              status: "finalizing_feedback",
            },
            monitoringState: this.mergeMonitoringStateFromPullRequest(task.state.pullRequestMonitoring, pullRequest, now),
          };
        }
      } else if (task.state.status !== "pushed") {
        throw new Error(this.describeAutomaticPrBatchFailure(task.state.status));
      }

      const resolvedState = await this.resolveAutomaticPrFlowBatch(previousState, workingDirectory, executor);
      return {
        automaticPrFlowState: {
          ...baseState,
          status: "monitoring",
          activeBatch: undefined,
          handledItems: resolvedState.handledItems,
          updatedAt: resolvedState.updatedAt,
          lastCheckedAt: resolvedState.lastCheckedAt,
        },
        monitoringState: this.mergeMonitoringStateFromPullRequest(task.state.pullRequestMonitoring, pullRequest, now),
      };
    }

    const snapshot = await this.deps.fetchAutomaticPrFlowSnapshot(pullRequest, workingDirectory, executor, git);
    const monitoringState = this.mergeMonitoringStateFromSnapshot(task.state.pullRequestMonitoring, snapshot, now);
    if (this.shouldTriggerAutomaticBranchUpdate(task, monitoringState, now)) {
      const requestedMonitoringState = {
        ...monitoringState,
        branchUpdate: {
          status: "requested" as const,
          lastDetectedAt: now,
          lastTriggeredAt: now,
        },
      };
      const updateResult = await this.deps.updateBranch(task.config.id);
      if (!updateResult.success) {
        return {
          automaticPrFlowState: {
            ...baseState,
            status: "monitoring",
          },
          monitoringState: {
            ...requestedMonitoringState,
            lastError: updateResult.error.message,
            branchUpdate: {
              ...requestedMonitoringState.branchUpdate,
              status: "failed",
              lastError: updateResult.error.message,
            },
          },
        };
      }

      if (updateResult.syncStatus === "conflicts_being_resolved") {
        return {
          automaticPrFlowState: {
            ...baseState,
            status: "monitoring",
          },
          monitoringState: {
            ...requestedMonitoringState,
            branchUpdate: {
              ...requestedMonitoringState.branchUpdate,
              status: "conflicts",
            },
          },
        };
      }

      return {
        automaticPrFlowState: {
          ...baseState,
          status: "monitoring",
        },
        monitoringState: requestedMonitoringState,
      };
    }

    const pendingFeedbackItems = snapshot.actionableItems.filter(
      (item) => !handledItems.some((handledItem) => handledItem.id === item.id),
    );
    const startAutomaticPrFeedbackBatch = async (
      sourceItems: AutomaticPrFlowFeedbackItem[],
      feedbackItems: AutomaticPrFlowExtractedFeedbackItem[],
      batchHandledItems: AutomaticPrFlowHandledItem[],
    ): Promise<NonNullable<Task["state"]["automaticPrFlow"]>> => {
      const batchId = crypto.randomUUID();
      const result = await this.deps.startAutomaticPrReviewCycle(task.config.id, {
        batchId,
        sourceItems,
        feedbackItems,
      });
      if (!result.success) {
        throw result.error;
      }

      return {
        ...baseState,
        status: "processing_feedback",
        handledItems: batchHandledItems,
        activeBatch: {
          batchId,
          itemIds: sourceItems.map((item) => item.id),
          items: sourceItems.map((item) => ({
            id: item.id,
            source: item.source,
            threadId: item.threadId,
          })),
          startedAt: now,
          reviewCycle: result.reviewCycle,
        },
      };
    };

    if (pendingFeedbackItems.length > 0) {
      const pendingWorkflowItems = pendingFeedbackItems.filter((item) => item.source === "workflow");
      if (pendingWorkflowItems.length > 0) {
        return {
          automaticPrFlowState: await startAutomaticPrFeedbackBatch(
            pendingWorkflowItems,
            [{
              text: AUTOMATIC_PR_WORKFLOW_FAILURE_MESSAGE,
              sourceItemIds: pendingWorkflowItems.map((item) => item.id),
            }],
            handledItems,
          ),
          monitoringState,
        };
      }

      const pendingReviewItems = pendingFeedbackItems.filter((item) => item.source !== "workflow");
      const extractedFeedback = await this.deps.extractAutomaticPrFeedback(task, workingDirectory, pendingReviewItems);
      const sourceItemIds = new Set(
        extractedFeedback.feedbackItems.flatMap((item) => item.sourceItemIds),
      );
      const sourceItems = pendingReviewItems.filter((item) => sourceItemIds.has(item.id));
      const ignoredItemIds = new Set(
        extractedFeedback.ignoredItems.map((ignoredItem) => ignoredItem.itemId),
      );
      const ignoredHandledItems = pendingReviewItems
        .filter((item) => ignoredItemIds.has(item.id))
        .map((item) => ({
          id: item.id,
          source: item.source,
          outcome: "ignored" as const,
          handledAt: now,
        }));
      const nextHandledItems = mergeHandledItems(handledItems, ignoredHandledItems);

      if (sourceItems.length === 0 || extractedFeedback.feedbackItems.length === 0) {
        return {
          automaticPrFlowState: {
            ...baseState,
            status: "monitoring",
            handledItems: nextHandledItems,
          },
          monitoringState,
        };
      }

      return {
        automaticPrFlowState: await startAutomaticPrFeedbackBatch(
          sourceItems,
          extractedFeedback.feedbackItems,
          nextHandledItems,
        ),
        monitoringState,
      };
    }

    return {
      automaticPrFlowState: {
        ...baseState,
        status: "monitoring",
      },
      monitoringState,
    };
  }

  private async resolveAutomaticPrFlowBatch(
    automaticPrFlowState: NonNullable<Task["state"]["automaticPrFlow"]>,
    workingDirectory: string,
    executor: CommandExecutor,
  ): Promise<NonNullable<Task["state"]["automaticPrFlow"]>> {
    const activeBatch = automaticPrFlowState.activeBatch;
    if (!activeBatch) {
      return automaticPrFlowState;
    }

    const now = new Date().toISOString();
    const handledItems = Array.isArray(automaticPrFlowState.handledItems)
      ? automaticPrFlowState.handledItems
      : [];
    for (const item of activeBatch.items) {
      if (item.source === "review_thread") {
        await this.deps.resolveAutomaticPrFlowReviewThread(item.threadId ?? item.id, workingDirectory, executor);
      }
    }

    const newlyHandledItems: NonNullable<Task["state"]["automaticPrFlow"]>["handledItems"] = activeBatch.items.map((item) => ({
      id: item.id,
      source: item.source,
      outcome: item.source === "review_thread" ? "resolved" : "manual",
      handledAt: now,
    }));

    return {
      ...automaticPrFlowState,
      status: "monitoring",
      updatedAt: now,
      lastCheckedAt: now,
      lastError: undefined,
      activeBatch: undefined,
      handledItems: mergeHandledItems(handledItems, newlyHandledItems),
    };
  }

  private mergeMonitoringStateFromSnapshot(
    currentState: Task["state"]["pullRequestMonitoring"],
    snapshot: AutomaticPrFlowSnapshot,
    now: string,
  ): NonNullable<Task["state"]["pullRequestMonitoring"]> {
    return this.mergeMonitoringStateFromPullRequest(currentState, snapshot.pullRequest, now);
  }

  private mergeMonitoringStateFromPullRequest(
    currentState: Task["state"]["pullRequestMonitoring"],
    pullRequest: AutomaticPrFlowPullRequest,
    now: string,
  ): NonNullable<Task["state"]["pullRequestMonitoring"]> {
    const nextStatus = pullRequest.state === "MERGED"
      ? "merged"
      : pullRequest.state === "CLOSED"
        ? "closed"
        : "open";

    const branchUpdate = this.isAutomaticBranchUpdateRequired(nextStatus, pullRequest.mergeStateStatus, pullRequest.viewerCanUpdateBranch)
      ? {
          status: currentState?.branchUpdate?.status ?? "required",
          lastDetectedAt: now,
          lastTriggeredAt: currentState?.branchUpdate?.lastTriggeredAt,
          lastError: currentState?.branchUpdate?.lastError,
        }
      : undefined;

    return {
      status: nextStatus,
      lastCheckedAt: now,
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.url,
      mergedAt: pullRequest.state === "MERGED" ? (pullRequest.mergedAt ?? currentState?.mergedAt ?? now) : undefined,
      mergeStateStatus: pullRequest.mergeStateStatus,
      viewerCanUpdateBranch: pullRequest.viewerCanUpdateBranch,
      branchUpdate,
      lastError: undefined,
    };
  }

  private isAutomaticBranchUpdateRequired(
    monitoringStatus: NonNullable<Task["state"]["pullRequestMonitoring"]>["status"],
    mergeStateStatus: Task["state"]["pullRequestMonitoring"] extends infer _T ? AutomaticPrFlowPullRequest["mergeStateStatus"] : never,
    viewerCanUpdateBranch: boolean | undefined,
  ): boolean {
    return monitoringStatus === "open"
      && mergeStateStatus === "BEHIND"
      && viewerCanUpdateBranch === true;
  }

  private shouldTriggerAutomaticBranchUpdate(
    task: Task,
    monitoringState: NonNullable<Task["state"]["pullRequestMonitoring"]>,
    now: string,
  ): boolean {
    if (task.state.status !== "pushed") {
      return false;
    }

    if (!this.isAutomaticBranchUpdateRequired(
      monitoringState.status,
      monitoringState.mergeStateStatus,
      monitoringState.viewerCanUpdateBranch,
    )) {
      return false;
    }

    if (this.deps.isTaskRunning(task.config.id)) {
      return false;
    }

    const branchUpdate = monitoringState.branchUpdate;
    if (!branchUpdate?.lastTriggeredAt || branchUpdate.status === "required") {
      return true;
    }

    if (branchUpdate.status === "failed" || branchUpdate.status === "conflicts") {
      return false;
    }

    const lastTriggeredAt = Date.parse(branchUpdate.lastTriggeredAt);
    const currentTime = Date.parse(now);
    if (!Number.isFinite(lastTriggeredAt) || !Number.isFinite(currentTime)) {
      return true;
    }

    return currentTime - lastTriggeredAt >= this.deps.intervalMs;
  }

  private buildAutomaticPrFlowErrorState(
    currentState: Task["state"]["automaticPrFlow"],
    now: string,
    error: string,
  ): NonNullable<Task["state"]["automaticPrFlow"]> {
    return {
      enabled: true,
      status: "error",
      startedAt: currentState?.startedAt ?? now,
      updatedAt: now,
      lastCheckedAt: now,
      pullRequestNumber: currentState?.pullRequestNumber,
      pullRequestUrl: currentState?.pullRequestUrl,
      activeBatch: currentState?.activeBatch,
      handledItems: currentState?.handledItems ?? [],
      lastError: error,
      stoppedAt: currentState?.stoppedAt,
    };
  }

  private async persistTaskMonitoringState(
    taskId: string,
    monitoringState: NonNullable<Task["state"]["pullRequestMonitoring"]> | undefined,
    automaticPrFlowState?: Task["state"]["automaticPrFlow"],
  ): Promise<void> {
    if (!monitoringState && !automaticPrFlowState) {
      return;
    }

    const latestTask = await this.deps.loadTask(taskId);
    if (!latestTask) {
      return;
    }

    const hasActiveAutomaticBatch = automaticPrFlowState?.activeBatch !== undefined
      || latestTask.state.automaticPrFlow?.activeBatch !== undefined;
    const hasTrackedBranchUpdate = monitoringState?.branchUpdate !== undefined
      || latestTask.state.pullRequestMonitoring?.branchUpdate !== undefined;
    if (latestTask.state.status !== "pushed" && !hasActiveAutomaticBatch && !hasTrackedBranchUpdate) {
      return;
    }

    const updatedState = {
      ...latestTask.state,
      pullRequestMonitoring: monitoringState ?? latestTask.state.pullRequestMonitoring,
      automaticPrFlow: automaticPrFlowState ?? latestTask.state.automaticPrFlow,
    };
    await this.deps.updateTaskState(taskId, updatedState);
    if (automaticPrFlowState !== undefined) {
      emitAutomaticPrFlowUpdatedEvent(this.deps.emitter, taskId, updatedState.automaticPrFlow);
    }
  }

  private getAutomaticPrFlowBatchStatus(
    task: Task,
  ): "processing_feedback" | "finalizing_feedback" | "ready_to_finalize" | "ready_to_resolve" {
    if (task.state.status === "resolving_conflicts") {
      return "finalizing_feedback";
    }

    if (this.deps.isTaskRunning(task.config.id)) {
      return "processing_feedback";
    }

    if (task.state.status === "pushed") {
      return "ready_to_resolve";
    }

    if (
      task.state.status === "idle"
      || task.state.status === "starting"
      || task.state.status === "running"
      || task.state.status === "waiting"
    ) {
      return "processing_feedback";
    }

    if (task.state.status === "completed") {
      return "ready_to_finalize";
    }

    return "ready_to_finalize";
  }

  private describeAutomaticPrBatchFailure(status: Task["state"]["status"]): string {
    switch (status) {
      case "max_iterations":
        return "Automatic PR review cycle reached max_iterations before the updated branch could be pushed.";
      case "failed":
        return "Automatic PR review cycle failed before the updated branch could be pushed.";
      case "stopped":
        return "Automatic PR review cycle was stopped before the updated branch could be pushed.";
      case "deleted":
        return "Automatic PR review cycle task was deleted before the updated branch could be pushed.";
      case "merged":
        return "Automatic PR review cycle ended in an unexpected merged state before the updated branch could be pushed.";
      default:
        return `Automatic PR review cycle ended in unexpected status: ${status}`;
    }
  }
}

export const pushedTaskMonitor = new PushedTaskMonitor();
