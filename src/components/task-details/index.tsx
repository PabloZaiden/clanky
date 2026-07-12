/**
 * TaskDetails component showing full task information with tabs.
 */

import { useState } from "react";
import { useTask, useMarkdownPreference, useToast } from "../../hooks";
import { Button, StatusBadge } from "../common";
import { TaskActionBar } from "../TaskActionBar";
import {
  getTaskStatusPill,
  isTaskActive,
  isTaskGenerating,
  canSendTerminalFollowUp,
  getEntityLabel,
} from "../../utils";
import type { TabId } from "./types";
import { tabs, formatDateTime } from "./types";
import { useTabState } from "./use-tab-state";
import { useTaskContent } from "./use-task-content";
import { useTaskActions } from "./use-task-actions";
import { useModels } from "./use-models";
import { useLogDisplayState } from "./use-log-display-state";
import { useTaskRemoteStatus } from "./use-task-remote-status";
import { TaskDetailsModals } from "./task-details-modals";
import { TaskDetailsTabContent } from "./task-details-tab-content";
import { replaceShellRoute } from "../app-shell/shell-navigation";
import { FrameworkMainHeaderPortal, useFrameworkMainHeaderSlots } from "../app-shell/main-header-portal";

export interface TaskDetailsProps {
  /** Task ID to display */
  taskId: string;
  /** Callback to go back to dashboard */
  onBack?: () => void;
  /** Whether to render the back button in shell layouts */
  showBackButton?: boolean;
  /** Navigate to the SSH session details view */
  onSelectSshSession?: (sshSessionId: string) => void;
  /** Navigate to the task-scoped code explorer view */
  onOpenTaskFiles?: (taskId: string) => void;
}

export function TaskDetails({
  taskId,
  onBack,
  showBackButton = true,
  onSelectSshSession,
  onOpenTaskFiles,
}: TaskDetailsProps) {
   const {
      task, loading, error, messages, toolCalls, logs, gitChangeCounter,
        accept, push, updateBranch, remove, purge, markMerged, closeLocalTask, manualCompleteTask,
       stopTask, setPending, sendFollowUp,
      getDiff, getPlan, getStatusFile, getPullRequestDestination,
      sendPlanFeedback, acceptPlan, discardPlan,
     addressReviewComments, enablePullRequestAutoMerge, startAutomaticPrFlow, stopAutomaticPrFlow, update, connectViaSsh,
    } = useTask(taskId);

  const { enabled: markdownEnabled } = useMarkdownPreference();
  const toast = useToast();
  const logDisplay = useLogDisplayState();
  const { activeTab, tabsWithUpdates, setTabsWithUpdates, handleTabChange } = useTabState({
    taskId, task,
    messagesCount: messages.length, toolCallsCount: toolCalls.length, logsCount: logs.length,
  });
  const content = useTaskContent({
    taskId, task, activeTab, gitChangeCounter,
    getDiff, getPlan, getStatusFile, getPullRequestDestination, setTabsWithUpdates,
  });
  const actions = useTaskActions({
    onBack,
    onSelectSshSession,
    onOpenTaskFiles: () => {
      if (onOpenTaskFiles) {
        onOpenTaskFiles(taskId);
        return;
      }
      replaceShellRoute({
        view: "code-explorer",
        target: { contentType: "task", taskId },
      });
     },
      toast,
        accept, push, updateBranch, remove, purge, markMerged, closeLocalTask, manualCompleteTask,
      addressReviewComments, enablePullRequestAutoMerge, startAutomaticPrFlow, stopAutomaticPrFlow, acceptPlan, discardPlan, connectViaSsh, update,
      fetchReviewComments: content.fetchReviewComments,
    });
  const { models, modelsLoading } = useModels({ directory: task?.config.directory, workspaceId: task?.config.workspaceId });
  const remoteStatus = useTaskRemoteStatus({
    directory: task?.config.directory,
    workspaceId: task?.config.workspaceId,
  });
  const frameworkHeader = useFrameworkMainHeaderSlots();
  const [headerStopSubmitting, setHeaderStopSubmitting] = useState(false);

  if (loading && !task) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-gray-500 border-t-transparent" />
      </div>
    );
  }

  if (!task) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-neutral-900 p-8">
        <div className="w-full">
          {showBackButton && onBack && <Button variant="ghost" onClick={onBack}>← Back</Button>}
          <div className="mt-8 text-center">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Not found</h2>
            <p className="mt-2 text-gray-500 dark:text-gray-400">{error || "The requested item does not exist."}</p>
          </div>
        </div>
      </div>
    );
  }

  const { config, state } = task;
  const isActive = isTaskActive(state.status);
  const labels = getEntityLabel(config.mode);
  const isPlanning = state.status === "planning";
  const canTerminalFollowUp = canSendTerminalFollowUp(state.status, state.reviewMode?.addressable);
  const isPlanReady = task.state.planMode?.isPlanReady ?? false;
  const isGenerating = isTaskGenerating(task);
  const statusPill = getTaskStatusPill(task);
  const feedbackRounds = task.state.planMode?.feedbackRounds ?? 0;
  const isLogActive = isActive || (isPlanning && !isPlanReady);
  const visibleTabs = tabs;
  const showLogActionBar = activeTab === "log" && (isActive || canTerminalFollowUp);
  const showPlanActionBar = activeTab === "plan" && isPlanning;
  const showActionBar = showLogActionBar || showPlanActionBar;
  const showHeaderStopButton = !showActionBar && activeTab !== "chat" && isGenerating && (isActive || isPlanning);
  const errorBannerSpacingClassName = "mx-3 mt-3 mb-3 sm:mx-4";

  async function handleHeaderStop() {
    if (headerStopSubmitting) {
      return;
    }

    setHeaderStopSubmitting(true);
    try {
      await stopTask();
    } finally {
      setHeaderStopSubmitting(false);
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-gray-50 dark:bg-neutral-900">
      {frameworkHeader.available ? (
        <FrameworkMainHeaderPortal
          title={config.name}
          badges={(
            <StatusBadge variant={statusPill.variant} size="sm" className="shrink-0">
              {statusPill.label}
            </StatusBadge>
          )}
          actions={showHeaderStopButton ? (
            <Button
              type="button"
              variant="danger"
              size="sm"
              loading={headerStopSubmitting}
              onClick={handleHeaderStop}
              aria-label="Stop task"
              title="Stop task"
            >
              Stop
            </Button>
          ) : null}
        />
      ) : null}
      <main className="flex flex-1 min-h-0 flex-col overflow-hidden">
        {error && (
          <div className={`${errorBannerSpacingClassName} rounded-md bg-red-50 dark:bg-red-900/20 p-3 flex-shrink-0`}>
            <p className="text-sm text-red-800 dark:text-red-300">{error}</p>
          </div>
        )}
        {state.error && (
          <div className={`${errorBannerSpacingClassName} rounded-md bg-red-50 dark:bg-red-900/20 p-3 flex-shrink-0 border border-red-200 dark:border-red-800`}>
            <div className="flex items-start gap-2">
              <div className="flex-shrink-0 text-red-600 dark:text-red-400">
                <svg className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="text-sm font-medium text-red-800 dark:text-red-300">{labels.capitalized} Error</h3>
                <p className="mt-1 text-sm text-red-700 dark:text-red-400 break-words">{state.error.message}</p>
                <div className="mt-2 text-xs text-red-600 dark:text-red-500">
                  <span className="mr-3">Iteration: {state.error.iteration}</span>
                  {state.error.timestamp && (
                    <span>Time: {formatDateTime(state.error.timestamp)}</span>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden">
          <div className="flex flex-shrink-0 overflow-x-auto border-b border-gray-200 bg-white px-3 dark:border-gray-700 dark:bg-neutral-800 sm:px-4">
            {visibleTabs.map((tab) => {
              const hasUpdate = tabsWithUpdates.has(tab.id as TabId);
              const showPlanIndicator = tab.id === "plan" && isPlanning && !isPlanReady && activeTab !== "plan";
              return (
                <button
                  key={tab.id}
                  onClick={() => handleTabChange(tab.id as TabId)}
                  className={`relative px-1.5 sm:px-4 py-2 text-xs sm:text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                    activeTab === tab.id
                      ? "border-gray-900 text-gray-900 dark:border-gray-100 dark:text-gray-100"
                      : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    {tab.label}
                    {showPlanIndicator && (
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-gray-500 opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-gray-600" />
                      </span>
                    )}
                  </span>
                  {hasUpdate && !showPlanIndicator && activeTab !== tab.id && (
                    <span className="absolute top-0.5 right-0.5 h-1.5 w-1.5 rounded-full bg-gray-500" />
                  )}
                </button>
              );
            })}
          </div>

          <TaskDetailsTabContent
            activeTab={activeTab} task={task} taskId={taskId} labels={labels}
            isPlanning={isPlanning} isPlanReady={isPlanReady}
            isLogActive={isLogActive} applyLogBottomSafeAreaPadding={!showActionBar}
            hasBottomActionBar={showActionBar}
            feedbackRounds={feedbackRounds} markdownEnabled={markdownEnabled}
            messages={messages} toolCalls={toolCalls} logs={logs}
            logDisplay={logDisplay}
            content={content}
            actions={actions}
            onFileOpenError={toast.error}
          />
        </div>
      </main>

      {showActionBar && (
        <TaskActionBar
          mode={config.mode} isPlanning={isPlanning} isGenerating={isGenerating}
          currentModel={config.model}
          models={models} modelsLoading={modelsLoading}
          variantDiscovery={{
            workspaceId: config.workspaceId,
          }}
          requireMessage={canTerminalFollowUp}
          submitLabel={canTerminalFollowUp ? "Restart" : undefined}
          onStop={isActive || isPlanning ? stopTask : undefined}
          onSubmit={async (options) => {
            if (isPlanning) { if (options.message) { await sendPlanFeedback(options.message, options.attachments); return true; } return false; }
            if (canTerminalFollowUp) {
              if (options.message) {
                return await sendFollowUp(
                  options.message,
                  options.model,
                  options.attachments,
                  state.status === "completed" || state.status === "pushed" ? "plain_chat" : "task_context",
                );
              }
              return false;
            }
            const result = await setPending(options);
            return result.success;
          }}
        />
      )}

      <TaskDetailsModals
        taskName={config.name}
        state={state}
        planContent={content.planContent}
        actions={actions}
        canPushToRemote={remoteStatus.hasOriginRemote !== false}
        remoteStatusLoading={remoteStatus.loading}
      />
    </div>
  );
}

export default TaskDetails;
