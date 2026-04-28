/**
 * Renders the active tab's content panel in LoopDetails.
 * Props are passed as grouped bundles to keep the call-site concise.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Loop } from "../../types";
import type { PersistedMessage, PersistedToolCall, LoopLogEntry } from "../../types/loop";
import type { EntityLabels } from "../../utils";
import type { TabId } from "./types";
import type { LogDisplayState } from "./use-log-display-state";
import type { UseLoopContentResult } from "./use-loop-content";
import type { UseLoopActionsResult } from "./use-loop-actions";
import type { UsePortForwardActionsResult } from "./use-port-forward-actions";
import type { PortForward } from "../../types";
import { LogTab } from "./log-tab";
import type { TranscriptFileLinkTarget } from "../log-viewer";
import { InfoTab } from "./info-tab";
import { PromptTab } from "./prompt-tab";
import { PlanTab } from "./plan-tab";
import { DiffTab } from "./diff-tab";
import { ActionsTab } from "./actions-tab";
import { ChatTab } from "./chat-tab";
import { getHashForShellRoute } from "../app-shell/shell-navigation";

interface LoopDetailsTabContentProps {
  activeTab: TabId;
  loop: Loop;
  loopId: string;
  labels: EntityLabels;
  isActive: boolean;
  isPlanning: boolean;
  isPlanReady: boolean;
  isLogActive: boolean;
  feedbackRounds: number;
  markdownEnabled: boolean;

  // Log tab raw data
  messages: PersistedMessage[];
  toolCalls: PersistedToolCall[];
  logs: LoopLogEntry[];

  // Bundled state from hooks
  logDisplay: LogDisplayState;
  portForward: UsePortForwardActionsResult;
  portForwardData: { forwards: PortForward[]; forwardsLoading: boolean; forwardsError: string | null };
  content: UseLoopContentResult;
  actions: UseLoopActionsResult;
  isLogFocusMode: boolean;
  onEnterLogFocusMode: () => void;
  onExitLogFocusMode: () => void;
  applySafeAreaBottomToLogFocusBar?: boolean;
}

export function LoopDetailsTabContent({
  activeTab,
  loop,
  loopId,
  labels,
  isActive,
  isPlanning,
  isPlanReady,
  isLogActive,
  feedbackRounds,
  markdownEnabled,
  messages,
  toolCalls,
  logs,
  logDisplay,
  portForward,
  portForwardData,
  content,
  actions,
  isLogFocusMode,
  onEnterLogFocusMode,
  onExitLogFocusMode,
  applySafeAreaBottomToLogFocusBar = false,
}: LoopDetailsTabContentProps) {
  const { config, state } = loop;
  const toolPathDisplayRoot = state.git?.worktreePath ?? config.directory;
  const [hasVisitedChatTab, setHasVisitedChatTab] = useState(activeTab === "chat");

  useEffect(() => {
    if (activeTab === "chat") {
      setHasVisitedChatTab(true);
    }
  }, [activeTab]);

  const getLoopFileHash = useCallback(({ path, startDirectory }: TranscriptFileLinkTarget) => getHashForShellRoute({
    view: "code-explorer",
    target: {
      contentType: "loop",
      loopId,
      startDirectory,
      filePath: path,
    },
  }), [loopId]);

  const openLinkedLoopFile = useCallback((target: TranscriptFileLinkTarget) => {
    window.location.hash = getLoopFileHash(target);
  }, [getLoopFileHash]);

  const fileLinkContext = useMemo(() => ({
    fileExplorerTarget: {
      type: "workspace" as const,
      id: config.workspaceId,
      startDirectory: toolPathDisplayRoot,
    },
    rootDirectory: toolPathDisplayRoot,
    getFileHref: (target: TranscriptFileLinkTarget) => `#${getLoopFileHash(target)}`,
    openFile: openLinkedLoopFile,
  }), [config.workspaceId, getLoopFileHash, openLinkedLoopFile, toolPathDisplayRoot]);

  return (
    <div
      className={
        activeTab === "log" && isLogFocusMode
          ? "flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden bg-[#1e1e1e]"
          : "flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden bg-white dark:bg-neutral-800"
      }
    >
      {activeTab === "log" && (
        <LogTab
          messages={messages}
          toolCalls={toolCalls}
          logs={logs}
          {...logDisplay}
          markdownEnabled={markdownEnabled}
          isLogActive={isLogActive}
          toolPathDisplayRoot={toolPathDisplayRoot}
          fileLinkContext={fileLinkContext}
          isFocusMode={isLogFocusMode}
          onEnterFocusMode={onEnterLogFocusMode}
          onExitFocusMode={onExitLogFocusMode}
          applySafeAreaBottomToFocusBar={applySafeAreaBottomToLogFocusBar}
        />
      )}
      {(activeTab === "chat" || hasVisitedChatTab) && (
        <div className={activeTab === "chat" ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "hidden"}>
          <ChatTab loopId={loopId} />
        </div>
      )}
      {activeTab === "info" && (
        <InfoTab
          loop={loop}
          labels={labels}
          onOpenLoopFiles={actions.handleOpenLoopFiles}
          sshConnecting={actions.sshConnecting}
          onConnectViaSsh={actions.handleConnectViaSsh}
          newForwardPort={portForward.newForwardPort}
          onNewForwardPortChange={portForward.setNewForwardPort}
          creatingForward={portForward.creatingForward}
          onCreateForward={portForward.handleCreateForward}
          forwards={portForwardData.forwards}
          forwardsLoading={portForwardData.forwardsLoading}
          forwardsError={portForwardData.forwardsError}
          onOpenForward={portForward.handleOpenForward}
          onCopyForwardUrl={portForward.handleCopyForwardUrl}
          onDeleteForward={portForward.handleDeleteForward}
          loopId={loopId}
          planningSettingsSubmitting={actions.planningSettingsSubmitting}
          onUpdatePlanningSettings={actions.handleUpdatePlanningSettings}
        />
      )}
      {activeTab === "prompt" && (
        <PromptTab config={config} state={state} isActive={isActive} />
      )}
      {activeTab === "plan" && (
        <PlanTab
          isPlanning={isPlanning}
          isPlanReady={isPlanReady}
          feedbackRounds={feedbackRounds}
          planContent={content.planContent}
          statusContent={content.statusContent}
          loadingContent={content.loadingContent}
          markdownEnabled={markdownEnabled}
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
          onManualCompleteModal={() => actions.setManualCompleteModal(true)}
          onPurgeModal={() => actions.setPurgeModal(true)}
          onAcceptModal={() => actions.setAcceptModal(true)}
          onDeleteModal={() => actions.setDeleteModal(true)}
          labels={labels}
          loop={loop}
          loadingComments={content.loadingComments}
          reviewComments={content.reviewComments}
        />
      )}
    </div>
  );
}
