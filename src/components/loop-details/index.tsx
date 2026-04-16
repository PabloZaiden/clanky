/**
 * LoopDetails component showing full loop information with tabs.
 */

import { useLoop, useLoopPortForwards, useMarkdownPreference, useToast } from "../../hooks";
import { Button, EditIcon, getStatusBadgeVariant, StatusBadge } from "../common";
import { LoopActionBar } from "../LoopActionBar";
import {
  getStatusLabel,
  getPlanningStatusLabel,
  isLoopActive,
  isLoopGenerating,
  canSendTerminalFollowUp,
  getEntityLabel,
} from "../../utils";
import type { TabId } from "./types";
import { tabs, formatDateTime } from "./types";
import { useTabState } from "./use-tab-state";
import { useLoopContent } from "./use-loop-content";
import { useLoopActions } from "./use-loop-actions";
import { useModels } from "./use-models";
import { usePortForwardActions } from "./use-port-forward-actions";
import { useLogDisplayState } from "./use-log-display-state";
import { useLogFocusMode } from "./use-log-focus-mode";
import { LoopDetailsModals } from "./loop-details-modals";
import { LoopDetailsTabContent } from "./loop-details-tab-content";
import { getFocusModeViewportStyle, useVisualViewport } from "../ssh-session/use-visual-viewport";
import { getHashForShellRoute } from "../app-shell/shell-navigation";

export interface LoopDetailsProps {
  /** Loop ID to display */
  loopId: string;
  /** Callback to go back to dashboard */
  onBack?: () => void;
  /** Whether to render the back button in shell layouts */
  showBackButton?: boolean;
  /** Left offset used when the shell keeps the collapsed-sidebar trigger visible */
  headerOffsetClassName?: string;
  /** Navigate to the SSH session details view */
  onSelectSshSession?: (sshSessionId: string) => void;
  /** Navigate to the loop-scoped code explorer view */
  onOpenLoopFiles?: (loopId: string) => void;
}

export function LoopDetails({
  loopId,
  onBack,
  showBackButton = true,
  headerOffsetClassName,
  onSelectSshSession,
  onOpenLoopFiles,
}: LoopDetailsProps) {
  const {
     loop, loading, error, messages, toolCalls, logs, gitChangeCounter,
      accept, push, updateBranch, remove, purge, markMerged, manualCompleteLoop,
      stopLoop, setPending, sendFollowUp,
     getDiff, getPlan, getStatusFile, getPullRequestDestination,
     sendPlanFeedback, acceptPlan, discardPlan,
    addressReviewComments, startAutomaticPrFlow, stopAutomaticPrFlow, update, connectViaSsh,
   } = useLoop(loopId);

  const { enabled: markdownEnabled } = useMarkdownPreference();
  const toast = useToast();
  const { forwards, loading: forwardsLoading, error: forwardsError, createForward, deleteForward } = useLoopPortForwards(loopId);

  const logDisplay = useLogDisplayState();
  const { isFocusMode: isLogFocusMode, toggleFocusMode: toggleLogFocusMode } = useLogFocusMode();
  const { activeTab, tabsWithUpdates, setTabsWithUpdates, handleTabChange } = useTabState({
    loopId, loop,
    messagesCount: messages.length, toolCallsCount: toolCalls.length, logsCount: logs.length,
  });
  const content = useLoopContent({
    loopId, loop, activeTab, gitChangeCounter,
    getDiff, getPlan, getStatusFile, getPullRequestDestination, setTabsWithUpdates,
  });
  const actions = useLoopActions({
    onBack,
    onSelectSshSession,
    onOpenLoopFiles: () => {
      if (onOpenLoopFiles) {
        onOpenLoopFiles(loopId);
        return;
      }
      window.location.hash = getHashForShellRoute({
        view: "code-explorer",
        target: { contentType: "loop", loopId },
      });
    },
     toast,
      accept, push, updateBranch, remove, purge, markMerged, manualCompleteLoop,
     addressReviewComments, startAutomaticPrFlow, stopAutomaticPrFlow, acceptPlan, discardPlan, connectViaSsh, update,
     fetchReviewComments: content.fetchReviewComments,
   });
  const { models, modelsLoading } = useModels({ directory: loop?.config.directory, workspaceId: loop?.config.workspaceId });
  const portForward = usePortForwardActions({ loopId, toast, createForward, deleteForward });
  const isLogFocusActive = activeTab === "log" && isLogFocusMode && !!loop;
  const viewport = useVisualViewport(isLogFocusActive);
  const focusModeContainerStyle = getFocusModeViewportStyle(isLogFocusActive, viewport);

  if (loading && !loop) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-gray-500 border-t-transparent" />
      </div>
    );
  }

  if (!loop) {
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

  const { config, state } = loop;
  const isActive = isLoopActive(state.status);
  const labels = getEntityLabel(config.mode);
  const isPlanning = state.status === "planning";
  const canTerminalFollowUp = canSendTerminalFollowUp(state.status, state.reviewMode?.addressable);
  const isPlanReady = loop.state.planMode?.isPlanReady ?? false;
  const isGenerating = isLoopGenerating(loop);
  const feedbackRounds = loop.state.planMode?.feedbackRounds ?? 0;
  const isLogActive = isActive || (isPlanning && !isPlanReady);
  const visibleTabs = tabs;
  const showActionBar = isActive || isPlanning || canTerminalFollowUp;
  const errorBannerSpacingClassName = isLogFocusActive ? "mx-3 mt-3 mb-3" : "mx-3 mt-3 mb-3 sm:mx-4";

  return (
    <div
      className={
        isLogFocusActive
          ? "flex h-full min-h-0 flex-col overflow-hidden bg-[#1e1e1e]"
          : "flex h-full flex-col overflow-hidden bg-gray-50 dark:bg-neutral-900"
      }
      style={focusModeContainerStyle}
    >
      {!isLogFocusActive && (
        <header className="bg-white dark:bg-neutral-800 border-b border-gray-200 dark:border-gray-700 flex-shrink-0 safe-area-top">
          <div className="px-4 sm:px-6 lg:px-8 py-2">
            <div className={[(headerOffsetClassName ?? "ml-14 sm:ml-16 lg:ml-0"), "flex min-h-14 flex-wrap items-center gap-3"].join(" ")}>
              {showBackButton && onBack && <Button variant="ghost" size="sm" onClick={onBack}>← Back</Button>}
              <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100 truncate">{config.name}</h1>
              <button
                onClick={() => actions.setRenameModal(true)}
                className="flex-shrink-0 p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:text-gray-300 dark:hover:bg-neutral-700"
                aria-label={`Rename ${labels.singular}`} title={`Rename ${labels.singular}`}
              >
                <EditIcon />
              </button>
              <StatusBadge variant={isPlanning ? (isPlanReady ? "plan_ready" : "planning") : getStatusBadgeVariant(state.status)} size="sm">
                {isPlanning ? getPlanningStatusLabel(isPlanReady) : getStatusLabel(state.status, state.syncState)}
              </StatusBadge>
              <span className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate hidden sm:inline">{config.directory}</span>
            </div>
          </div>
        </header>
      )}

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
          {!isLogFocusActive && (
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
          )}

          <LoopDetailsTabContent
            activeTab={activeTab} loop={loop} loopId={loopId} labels={labels}
            isActive={isActive} isPlanning={isPlanning} isPlanReady={isPlanReady}
            isLogActive={isLogActive} feedbackRounds={feedbackRounds} markdownEnabled={markdownEnabled}
            messages={messages} toolCalls={toolCalls} logs={logs}
            logDisplay={logDisplay}
            portForward={portForward}
            portForwardData={{ forwards, forwardsLoading, forwardsError }}
            content={content}
            actions={actions}
            isLogFocusMode={isLogFocusActive}
            onEnterLogFocusMode={toggleLogFocusMode}
            onExitLogFocusMode={toggleLogFocusMode}
            applySafeAreaBottomToLogFocusBar={!showActionBar}
          />
        </div>
      </main>

      {showActionBar && (
        <LoopActionBar
          mode={config.mode} isPlanning={isPlanning} isGenerating={isGenerating}
          currentModel={config.model}
          models={models} modelsLoading={modelsLoading}
          requireMessage={canTerminalFollowUp}
          submitLabel={canTerminalFollowUp ? "Restart" : undefined}
          onStop={isActive || isPlanning ? stopLoop : undefined}
          onSubmit={async (options) => {
            if (isPlanning) { if (options.message) { await sendPlanFeedback(options.message, options.attachments); return true; } return false; }
            if (canTerminalFollowUp) { if (options.message) return await sendFollowUp(options.message, options.model, options.attachments); return false; }
            const result = await setPending(options);
            return result.success;
          }}
        />
      )}

      <LoopDetailsModals loopName={config.name} state={state} planContent={content.planContent} actions={actions} />
    </div>
  );
}

export default LoopDetails;
