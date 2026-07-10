import type { FileContentResponse } from "../../types";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { StatusTab } from "./status-tab";
import { taskDetailsTabContentClassName, taskDetailsTabScrollContainerClassName } from "./tab-layout";

interface PlanTabProps {
  isPlanning: boolean;
  isPlanReady: boolean;
  feedbackRounds: number;
  planContent: FileContentResponse | null;
  statusContent: FileContentResponse | null;
  loadingPlanContent: boolean;
  loadingStatusContent: boolean;
  markdownEnabled: boolean;
  hasBottomActionBar: boolean;
}

export function PlanTab({
  isPlanning,
  isPlanReady,
  feedbackRounds,
  planContent,
  statusContent,
  loadingPlanContent,
  loadingStatusContent,
  markdownEnabled,
  hasBottomActionBar,
}: PlanTabProps) {
  return (
    <div className={`${taskDetailsTabScrollContainerClassName} ${hasBottomActionBar ? "" : "safe-area-bottom"}`}>
      <div className={`${taskDetailsTabContentClassName} space-y-4`}>
        <div>
          {/* Feedback rounds counter (planning mode only) */}
          {isPlanning && feedbackRounds > 0 && (
            <div className="mb-3 flex items-center text-sm text-gray-600 dark:text-gray-400">
              Feedback rounds: {feedbackRounds}
            </div>
          )}

          {loadingPlanContent && !isPlanning ? (
            <div className="flex justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-gray-500 border-t-transparent" />
            </div>
          ) : isPlanning && !planContent?.exists ? (
            /* Waiting for AI to generate plan (no content yet) */
            <div className="flex items-center gap-3 text-gray-600 dark:text-gray-400 py-8 justify-center">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-gray-500 opacity-75" />
                <span className="relative inline-flex rounded-full h-3 w-3 bg-gray-600" />
              </span>
              <span>Waiting for AI to generate plan...</span>
            </div>
          ) : isPlanning && planContent?.exists && !isPlanReady ? (
            /* Plan content exists but AI is still writing */
            <div className="relative">
              <MarkdownRenderer content={planContent.content} dimmed rawMode={!markdownEnabled} className="min-w-0 rounded-lg bg-gray-50 p-4 dark:bg-neutral-900" />
              <div className="absolute top-4 right-4 flex items-center gap-3 text-gray-600 dark:text-gray-400 bg-white dark:bg-neutral-800 px-3 py-2 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-gray-500 opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-gray-600" />
                </span>
                <span className="text-sm font-medium">AI is still writing...</span>
              </div>
            </div>
          ) : planContent?.exists ? (
            <MarkdownRenderer content={planContent.content} rawMode={!markdownEnabled} className="min-w-0 rounded-lg bg-gray-50 p-4 dark:bg-neutral-900" />
          ) : (
            <p className="text-gray-500 dark:text-gray-400 text-center py-8">
              No plan.md file found in the project directory.
            </p>
          )}
        </div>

        {/* Status file content below the plan */}
        <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">Status</h3>
          <StatusTab
            statusContent={statusContent}
            loadingStatusContent={loadingStatusContent}
            markdownEnabled={markdownEnabled}
            embedded
          />
        </div>
      </div>
    </div>
  );
}
