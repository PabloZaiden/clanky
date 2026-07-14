import type { PersistedMessage, PersistedToolCall, TaskLogEntry } from "@/shared/task";
import { LogViewer } from "../LogViewer";
import { taskDetailsTabPaddingClassName } from "./tab-layout";
import type { TranscriptFileLinkContext } from "../log-viewer";

interface LogTabProps {
  messages: PersistedMessage[];
  toolCalls: PersistedToolCall[];
  logs: TaskLogEntry[];
  showSystemInfo: boolean;
  onShowSystemInfoChange: (v: boolean) => void;
  showReasoning: boolean;
  onShowReasoningChange: (v: boolean) => void;
  showTools: boolean;
  onShowToolsChange: (v: boolean) => void;
  markdownEnabled: boolean;
  isLogActive: boolean;
  applyBottomSafeAreaPadding: boolean;
  toolPathDisplayRoot?: string;
  fileLinkContext?: TranscriptFileLinkContext;
}

export function LogTab({
  messages,
  toolCalls,
  logs,
  showSystemInfo,
  onShowSystemInfoChange,
  showReasoning,
  onShowReasoningChange,
  showTools,
  onShowToolsChange,
  markdownEnabled,
  isLogActive,
  applyBottomSafeAreaPadding,
  toolPathDisplayRoot,
  fileLinkContext,
}: LogTabProps) {
  const logViewerId = "logs-viewer";

  return (
    <div className="flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden bg-gray-50 dark:bg-[#171717]" data-testid="task-log-panel">
      <div className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
        <LogViewer
          id={logViewerId}
          messages={messages}
          toolCalls={toolCalls}
          logs={logs}
          showSystemInfo={showSystemInfo}
          showReasoning={showReasoning}
          showTools={showTools}
          markdownEnabled={markdownEnabled}
          isActive={isLogActive}
          toolPathDisplayRoot={toolPathDisplayRoot}
          fileLinkContext={fileLinkContext}
          surfaceClassName="bg-transparent"
          transcriptClassName={`flex w-full flex-col ${taskDetailsTabPaddingClassName}`}
        />
      </div>

      <div className={`flex-shrink-0 border-t border-gray-200 dark:border-gray-700 ${applyBottomSafeAreaPadding ? "safe-area-bottom" : ""}`}>
        <div
          className="hide-scrollbar flex min-w-0 items-center gap-2 overflow-x-auto whitespace-nowrap px-1.5 py-2 sm:flex-wrap sm:gap-3 sm:overflow-visible sm:p-4"
          style={{ WebkitOverflowScrolling: "touch" }}
        >
          <label className="shrink-0 cursor-pointer text-[11px] text-gray-700 dark:text-gray-300 sm:text-sm">
            <span className="flex items-center gap-1 whitespace-nowrap sm:gap-2">
              <input
                type="checkbox"
                checked={showSystemInfo}
                onChange={(e) => onShowSystemInfoChange(e.target.checked)}
                aria-label="Show system info"
                className="rounded border-gray-300 text-gray-700 focus:ring-gray-500 focus:ring-offset-0 dark:border-gray-600 dark:text-gray-300"
              />
              <span>System</span>
            </span>
          </label>
          <label className="shrink-0 cursor-pointer text-[11px] text-gray-700 dark:text-gray-300 sm:text-sm">
            <span className="flex items-center gap-1 whitespace-nowrap sm:gap-2">
              <input
                type="checkbox"
                checked={showReasoning}
                onChange={(e) => onShowReasoningChange(e.target.checked)}
                aria-label="Show reasoning"
                className="rounded border-gray-300 text-gray-700 focus:ring-gray-500 focus:ring-offset-0 dark:border-gray-600 dark:text-gray-300"
              />
              <span>Reasoning</span>
            </span>
          </label>
          <label className="shrink-0 cursor-pointer text-[11px] text-gray-700 dark:text-gray-300 sm:text-sm">
            <span className="flex items-center gap-1 whitespace-nowrap sm:gap-2">
              <input
                type="checkbox"
                checked={showTools}
                onChange={(e) => onShowToolsChange(e.target.checked)}
                aria-label="Show tools"
                className="rounded border-gray-300 text-gray-700 focus:ring-gray-500 focus:ring-offset-0 dark:border-gray-600 dark:text-gray-300"
              />
              <span>Tools</span>
            </span>
          </label>
        </div>
      </div>
    </div>
  );
}
