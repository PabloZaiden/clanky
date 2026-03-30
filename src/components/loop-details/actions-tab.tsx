import type { Loop, ReviewComment, LoopState } from "../../types/loop";
import type { FileContentResponse, PullRequestDestinationResponse } from "../../types";
import type { EntityLabels } from "../../utils";
import { isFinalState, canAccept, canMarkMerged } from "../../utils";
import { ReviewTab } from "./review-tab";

interface ActionsTabProps {
  isPlanning: boolean;
  isPlanReady: boolean;
  planContent: FileContentResponse | null;
  planActionSubmitting: boolean;
  onAcceptPlan: (mode: "start_loop" | "open_ssh") => void;
  onDiscardPlanModal: () => void;
  state: LoopState;
  loadingPullRequestDestination: boolean;
  pullRequestDestination: PullRequestDestinationResponse | null;
  onOpenPullRequest: () => void;
  onAddressCommentsModal: () => void;
  onUpdateBranchModal: () => void;
  onMarkMergedModal: () => void;
  onPurgeModal: () => void;
  onAcceptModal: () => void;
  onDeleteModal: () => void;
  labels: EntityLabels;
  loop: Loop;
  loadingComments: boolean;
  reviewComments: ReviewComment[];
}

export function ActionsTab({
  isPlanning,
  isPlanReady,
  planContent,
  planActionSubmitting,
  onAcceptPlan,
  onDiscardPlanModal,
  state,
  loadingPullRequestDestination,
  pullRequestDestination,
  onOpenPullRequest,
  onAddressCommentsModal,
  onUpdateBranchModal,
  onMarkMergedModal,
  onPurgeModal,
  onAcceptModal,
  onDeleteModal,
  labels,
  loop,
  loadingComments,
  reviewComments,
}: ActionsTabProps) {
  return (
    <div className="flex min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-4 dark-scrollbar">
      <div className="min-w-0 w-full space-y-4">
        <div className="max-w-md min-w-0 space-y-2">

        {isPlanning ? (
          <>
            <button
              onClick={() => onAcceptPlan("start_loop")}
              disabled={planActionSubmitting || !isPlanReady || !planContent?.content?.trim()}
              className="w-full flex items-center gap-4 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-700/50 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                <span className="text-green-600 dark:text-green-400 text-sm">✓</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {planActionSubmitting ? "Accepting..." : "Accept Plan & Start Loop"}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {isPlanReady
                    ? "Accept the plan and begin loop execution"
                    : "Waiting for AI to finish writing the plan..."}
                </div>
              </div>
              <span className="text-gray-400 dark:text-gray-500">→</span>
            </button>
            <button
              onClick={() => onAcceptPlan("open_ssh")}
              disabled={planActionSubmitting || !isPlanReady || !planContent?.content?.trim()}
              className="w-full flex items-center gap-4 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-700/50 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-100 dark:bg-neutral-800 flex items-center justify-center">
                <span className="text-gray-700 dark:text-gray-300 text-sm">⌁</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {planActionSubmitting ? "Accepting..." : "Accept Plan & Open SSH"}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {isPlanReady
                    ? "Accept the plan, mark the loop complete, and open its SSH session"
                    : "Waiting for AI to finish writing the plan..."}
                </div>
              </div>
              <span className="text-gray-400 dark:text-gray-500">→</span>
            </button>
            <button
              onClick={onDiscardPlanModal}
              disabled={planActionSubmitting}
              className="w-full flex items-center gap-4 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-700/50 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                <span className="text-red-600 dark:text-red-400 text-sm">✗</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Discard Plan</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">Discard this plan and delete the loop</div>
              </div>
              <span className="text-gray-400 dark:text-gray-500">→</span>
            </button>
          </>
        ) : isFinalState(state.status) ? (
          <>
            {state.status === "pushed" && state.reviewMode?.addressable && (
              <button
                onClick={onOpenPullRequest}
                disabled={loadingPullRequestDestination || !pullRequestDestination?.enabled}
                className="w-full flex items-center gap-4 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-700/50 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-100 dark:bg-neutral-800 flex items-center justify-center">
                  <span className="text-gray-700 dark:text-gray-300 text-sm">↗</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Go to PR</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {loadingPullRequestDestination
                      ? "Checking for an existing pull request..."
                      : pullRequestDestination?.enabled
                      ? pullRequestDestination.destinationType === "existing_pr"
                        ? "Open the existing pull request for this branch"
                        : "Open GitHub to create a pull request from this branch"
                      : pullRequestDestination?.disabledReason ?? "Pull request navigation is unavailable."}
                  </div>
                </div>
                <span className="text-gray-400 dark:text-gray-500">→</span>
              </button>
            )}
            {state.reviewMode?.addressable && state.status !== "deleted" && (
              <button
                onClick={onAddressCommentsModal}
                className="w-full flex items-center gap-4 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-700/50 transition-colors text-left"
              >
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-100 dark:bg-neutral-800 flex items-center justify-center">
                  <span className="text-gray-700 dark:text-gray-300 text-sm">💬</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Address Comments</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">Submit comments for the next review cycle</div>
                </div>
                <span className="text-gray-400 dark:text-gray-500">→</span>
              </button>
            )}
            {state.status === "pushed" && state.git && (
              <button
                onClick={onUpdateBranchModal}
                className="w-full flex items-center gap-4 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-700/50 transition-colors text-left"
              >
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-gray-100 dark:bg-neutral-800 flex items-center justify-center">
                  <span className="text-gray-700 dark:text-gray-300 text-sm">⟳</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Update Branch</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">Sync with base branch and push latest changes</div>
                </div>
                <span className="text-gray-400 dark:text-gray-500">→</span>
              </button>
            )}
            {canMarkMerged(state.status, Boolean(state.git)) && (
              <button
                onClick={onMarkMergedModal}
                className="w-full flex items-center gap-4 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-700/50 transition-colors text-left"
              >
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                  <span className="text-green-600 dark:text-green-400 text-sm">⤵</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Mark as Merged</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">Keep this loop as merged after the branch landed elsewhere</div>
                </div>
                <span className="text-gray-400 dark:text-gray-500">→</span>
              </button>
            )}
            <button
              onClick={onPurgeModal}
              className="w-full flex items-center gap-4 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-700/50 transition-colors text-left"
            >
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                <span className="text-red-600 dark:text-red-400 text-sm">🗑</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Purge {labels.capitalized}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">Delete this {labels.singular} and all associated data</div>
              </div>
              <span className="text-gray-400 dark:text-gray-500">→</span>
            </button>
          </>
        ) : (
          <>
            {canAccept(state.status) && state.git && (
              <button
                onClick={onAcceptModal}
                className="w-full flex items-center gap-4 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-700/50 transition-colors text-left"
              >
                <div className="flex-shrink-0 w-8 h-8 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                  <span className="text-green-600 dark:text-green-400 text-sm">✓</span>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Accept</div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">Accept changes and merge or push to remote</div>
                </div>
                <span className="text-gray-400 dark:text-gray-500">→</span>
              </button>
            )}
            <button
              onClick={onDeleteModal}
              className="w-full flex items-center gap-4 p-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-neutral-700/50 transition-colors text-left"
            >
              <div className="flex-shrink-0 w-8 h-8 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                <span className="text-red-600 dark:text-red-400 text-sm">✗</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Delete {labels.capitalized}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">Cancel and delete this {labels.singular}</div>
              </div>
              <span className="text-gray-400 dark:text-gray-500">→</span>
            </button>
          </>
        )}
        </div>

        {/* Review cycle history — shown when review mode is active */}
        {loop.state.reviewMode && (
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <ReviewTab
              loop={loop}
              labels={labels}
              loadingComments={loadingComments}
              reviewComments={reviewComments}
              embedded
            />
          </div>
        )}
      </div>
    </div>
  );
}
