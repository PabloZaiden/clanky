import type { PersistedMessage, PersistedToolCall, LoopLogEntry } from "../../types/loop";
import { LogViewer } from "../LogViewer";
import { Button } from "../common";
import { LogFocusModeBar } from "./log-focus-mode-bar";
import { loopDetailsTabPaddingClassName } from "./tab-layout";
import type { TranscriptFileLinkContext } from "../log-viewer";

interface LogTabProps {
  messages: PersistedMessage[];
  toolCalls: PersistedToolCall[];
  logs: LoopLogEntry[];
  showSystemInfo: boolean;
  onShowSystemInfoChange: (v: boolean) => void;
  showReasoning: boolean;
  onShowReasoningChange: (v: boolean) => void;
  showTools: boolean;
  onShowToolsChange: (v: boolean) => void;
  autoScroll: boolean;
  onAutoScrollChange: (v: boolean) => void;
  markdownEnabled: boolean;
  isLogActive: boolean;
  isFocusMode: boolean;
  onEnterFocusMode: () => void;
  onExitFocusMode: () => void;
  applySafeAreaBottomToFocusBar?: boolean;
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
  autoScroll,
  onAutoScrollChange,
  markdownEnabled,
  isLogActive,
  isFocusMode,
  onEnterFocusMode,
  onExitFocusMode,
  applySafeAreaBottomToFocusBar = false,
  toolPathDisplayRoot,
  fileLinkContext,
}: LogTabProps) {
  const logViewerId = "logs-viewer";

  return (
    <div className="flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden bg-gray-50 dark:bg-[#171717]" data-testid="loop-log-panel">
      <div className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
        <LogViewer
          id={logViewerId}
          messages={messages}
          toolCalls={toolCalls}
          logs={logs}
          showSystemInfo={showSystemInfo}
          showReasoning={showReasoning}
          showTools={showTools}
          autoScroll={autoScroll}
          markdownEnabled={markdownEnabled}
          isActive={isLogActive}
          toolPathDisplayRoot={toolPathDisplayRoot}
          fileLinkContext={fileLinkContext}
          surfaceClassName="bg-transparent"
          transcriptClassName={
            isFocusMode
              ? "flex w-full flex-col px-3 pt-3 pb-5 sm:px-4 sm:pt-4 sm:pb-6 lg:px-5"
              : `flex w-full flex-col ${loopDetailsTabPaddingClassName}`
          }
        />
      </div>

      {isFocusMode ? (
        <LogFocusModeBar
          showSystemInfo={showSystemInfo}
          onShowSystemInfoChange={onShowSystemInfoChange}
          showReasoning={showReasoning}
          onShowReasoningChange={onShowReasoningChange}
          showTools={showTools}
          onShowToolsChange={onShowToolsChange}
          autoScroll={autoScroll}
          onAutoScrollChange={onAutoScrollChange}
          onExitFocusMode={onExitFocusMode}
          applySafeAreaBottom={applySafeAreaBottomToFocusBar}
        />
      ) : (
        <div className="flex-shrink-0 border-t border-gray-200 px-1.5 py-2 dark:border-gray-700 sm:p-4">
          <div
            className="hide-scrollbar flex min-w-0 items-center gap-2 overflow-x-auto whitespace-nowrap sm:flex-wrap sm:gap-3 sm:overflow-visible"
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
            <label className="shrink-0 cursor-pointer text-[11px] text-gray-700 dark:text-gray-300 sm:text-sm">
              <span className="flex items-center gap-1 whitespace-nowrap sm:gap-2">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => onAutoScrollChange(e.target.checked)}
                  aria-label="Autoscroll"
                  className="rounded border-gray-300 text-gray-700 focus:ring-gray-500 focus:ring-offset-0 dark:border-gray-600 dark:text-gray-300"
                />
                <span>Autoscroll</span>
              </span>
            </label>
            <Button
              type="button"
              variant="secondary"
              size="xs"
              className="shrink-0"
              onClick={onEnterFocusMode}
              aria-label="Enter focus mode"
              title="Focus mode — fullscreen logs with compact controls"
            >
              <span>Focus</span>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
