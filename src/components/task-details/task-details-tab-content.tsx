/**
 * Renders the active tab's content panel in TaskDetails.
 * Props are passed as grouped bundles to keep the call-site concise.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { appAbsoluteUrl } from "../../lib/public-path";
import { replaceWebAppRoute, routeToHash } from "@pablozaiden/webapp/web";
import type { MessageData, Task, TaskLogEntry, ToolCallData, ToolCallDisplayData } from "@/shared";
import type { EntityLabels } from "../../utils";
import type { TabId } from "./types";
import type { LogDisplayState } from "./use-log-display-state";
import type { UseTaskContentResult } from "./use-task-content";
import type { UseTaskActionsResult } from "./use-task-actions";
import { LogTab } from "./log-tab";
import type { TranscriptFileLinkTarget } from "../log-viewer";
import { InfoTab } from "./info-tab";
import { PlanTab } from "./plan-tab";
import { DiffTab } from "./diff-tab";
import { ActionsTab } from "./actions-tab";
import { ChatTab } from "./chat-tab";

interface TaskDetailsTabContentProps {
  activeTab: TabId;
  task: Task;
  taskId: string;
  labels: EntityLabels;
  isPlanning: boolean;
  isPlanReady: boolean;
  isLogActive: boolean;
  applyLogBottomSafeAreaPadding: boolean;
  hasBottomActionBar: boolean;
  feedbackRounds: number;
  markdownEnabled: boolean;

  // Log tab raw data
  messages: MessageData[];
  toolCalls: ToolCallDisplayData[];
  logs: TaskLogEntry[];
  onLoadToolDetails: (toolCallId: string) => Promise<ToolCallData | null>;

  // Bundled state from hooks
  logDisplay: LogDisplayState;
  content: UseTaskContentResult;
  actions: UseTaskActionsResult;
  onFileOpenError: (message: string) => void;
}

export function TaskDetailsTabContent({
  activeTab,
  task,
  taskId,
  labels,
  isPlanning,
  isPlanReady,
  isLogActive,
  applyLogBottomSafeAreaPadding,
  hasBottomActionBar,
  feedbackRounds,
  markdownEnabled,
  messages,
  toolCalls,
  logs,
  onLoadToolDetails,
  logDisplay,
  content,
  actions,
  onFileOpenError,
}: TaskDetailsTabContentProps) {
  const { config, state } = task;
  const toolPathDisplayRoot = state.git?.worktreePath ?? config.directory;
  const [hasVisitedChatTab, setHasVisitedChatTab] = useState(activeTab === "chat");

  useEffect(() => {
    if (activeTab === "chat") {
      setHasVisitedChatTab(true);
    }
  }, [activeTab]);

  const getTaskFileRoute = useCallback(({ path, startDirectory, kind }: TranscriptFileLinkTarget) => ({
    view: "code-explorer",
    contentType: "task",
    taskId,
    startDirectory,
    filePath: kind === "directory" ? undefined : path,
  }), [taskId]);

  const openLinkedTaskFile = useCallback((target: TranscriptFileLinkTarget) => {
    replaceWebAppRoute(getTaskFileRoute(target));
  }, [getTaskFileRoute]);

  const fileLinkContext = useMemo(() => ({
    fileExplorerTarget: {
      type: "workspace" as const,
      id: config.workspaceId,
      startDirectory: toolPathDisplayRoot,
    },
    rootDirectory: toolPathDisplayRoot,
    getFileHref: (target: TranscriptFileLinkTarget) => appAbsoluteUrl(routeToHash(getTaskFileRoute(target))),
    openFile: openLinkedTaskFile,
    onFileOpenError,
  }), [config.workspaceId, getTaskFileRoute, onFileOpenError, openLinkedTaskFile, toolPathDisplayRoot]);

  return (
    <div className="flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden bg-white dark:bg-neutral-800">
      {activeTab === "log" && (
        <LogTab
          messages={messages}
          toolCalls={toolCalls}
          logs={logs}
          {...logDisplay}
          markdownEnabled={markdownEnabled}
          isLogActive={isLogActive}
          applyBottomSafeAreaPadding={applyLogBottomSafeAreaPadding}
          toolPathDisplayRoot={toolPathDisplayRoot}
          fileLinkContext={fileLinkContext}
          onLoadToolDetails={onLoadToolDetails}
        />
      )}
      {(activeTab === "chat" || hasVisitedChatTab) && (
        <div className={activeTab === "chat" ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "hidden"}>
          <ChatTab taskId={taskId} />
        </div>
      )}
      {activeTab === "info" && (
        <InfoTab
          task={task}
          labels={labels}
          onOpenTaskFiles={actions.handleOpenTaskFiles}
          sshConnecting={actions.sshConnecting}
          onConnectViaSsh={actions.handleConnectViaSsh}
          planningSettingsSubmitting={actions.planningSettingsSubmitting}
          onUpdatePlanningSettings={actions.handleUpdatePlanningSettings}
        />
      )}
      {activeTab === "plan" && (
        <PlanTab
          isPlanning={isPlanning}
          isPlanReady={isPlanReady}
          feedbackRounds={feedbackRounds}
          planContent={content.planContent}
          statusContent={content.statusContent}
          loadingPlanContent={content.loadingPlanContent}
          loadingStatusContent={content.loadingStatusContent}
          markdownEnabled={markdownEnabled}
          hasBottomActionBar={hasBottomActionBar}
        />
      )}
      {activeTab === "diff" && (
        <DiffTab
          diffContent={content.diffContent}
          loadingContent={content.loadingContent}
          expandedFiles={content.expandedFiles}
          onExpandedFilesChange={content.setExpandedFiles}
        />
      )}
      {activeTab === "actions" && (
        <ActionsTab
          isPlanning={isPlanning}
          isPlanReady={isPlanReady}
          planContent={content.planContent}
          planActionSubmitting={actions.planActionSubmitting}
          onAcceptPlan={actions.handleAcceptPlan}
          onDiscardPlanModal={() => actions.setDiscardPlanModal(true)}
          state={state}
          loadingPullRequestDestination={content.loadingPullRequestDestination}
          pullRequestDestination={content.pullRequestDestination}
          onOpenPullRequest={() => actions.handleOpenPullRequest(content.pullRequestDestination)}
          onEnablePullRequestAutoMerge={actions.handleEnablePullRequestAutoMerge}
          pullRequestAutoMergeSubmitting={actions.pullRequestAutoMergeSubmitting}
          onStartAutomaticPrFlowModal={() => actions.setStartAutomaticPrFlowModal(true)}
          onStopAutomaticPrFlowModal={() => actions.setStopAutomaticPrFlowModal(true)}
          onAddressCommentsModal={() => actions.setAddressCommentsModal(true)}
          onUpdateBranchModal={() => actions.setUpdateBranchModal(true)}
          onMarkMergedModal={() => actions.setMarkMergedModal(true)}
          onCloseLocalModal={() => actions.setCloseLocalModal(true)}
          onManualCompleteModal={() => actions.setManualCompleteModal(true)}
          onPurgeModal={() => actions.setPurgeModal(true)}
          onAcceptModal={() => actions.setAcceptModal(true)}
          onDeleteModal={() => actions.setDeleteModal(true)}
          labels={labels}
          task={task}
          loadingComments={content.loadingComments}
          reviewComments={content.reviewComments}
        />
      )}
    </div>
  );
}
