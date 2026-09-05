import type { MessageData, TaskLogEntry, ToolCallData, ToolCallDisplayData } from "@/shared";
import { LogViewer } from "../LogViewer";
import { taskDetailsTabPaddingClassName } from "./tab-layout";
import type { TranscriptFileLinkContext } from "../log-viewer";

interface LogTabProps {
  messages: MessageData[];
  toolCalls: ToolCallDisplayData[];
  logs: TaskLogEntry[];
  showSystemInfo: boolean;
  onShowSystemInfoChange: (v: boolean) => void;
  showTools: boolean;
  onShowToolsChange: (v: boolean) => void;
  markdownEnabled: boolean;
  isLogActive: boolean;
  applyBottomSafeAreaPadding: boolean;
  toolPathDisplayRoot?: string;
  fileLinkContext?: TranscriptFileLinkContext;
  onLoadToolDetails?: (toolCallId: string) => Promise<ToolCallData | null>;
}

export function LogTab({
  messages,
  toolCalls,
  logs,
  showSystemInfo,
  onShowSystemInfoChange,
  showTools,
  onShowToolsChange,
  markdownEnabled,
  isLogActive,
  applyBottomSafeAreaPadding,
  toolPathDisplayRoot,
  fileLinkContext,
  onLoadToolDetails,
}: LogTabProps) {
  const logViewerId = "logs-viewer";

  return (
    <div className="flex min-w-0 flex-1 min-h-0 flex-col overflow-hidden bg-transparent" data-testid="task-log-panel">
      <div className="flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
        <LogViewer
          id={logViewerId}
          messages={messages}
          toolCalls={toolCalls}
          logs={logs}
          showSystemInfo={showSystemInfo}
          showTools={showTools}
          markdownEnabled={markdownEnabled}
          isActive={isLogActive}
          toolPathDisplayRoot={toolPathDisplayRoot}
          fileLinkContext={fileLinkContext}
          surfaceClassName="bg-transparent"
          transcriptClassName={`flex w-full flex-col ${taskDetailsTabPaddingClassName}`}
          onLoadToolDetails={onLoadToolDetails}
        />
      </div>

      <div className={`flex-shrink-0 ${applyBottomSafeAreaPadding ? "safe-area-bottom" : ""}`}>
        <div
          className="hide-scrollbar flex min-w-0 items-center gap-2 overflow-x-auto whitespace-nowrap px-1.5 py-2 sm:flex-wrap sm:gap-3 sm:overflow-visible sm:p-4"
          style={{ WebkitOverflowScrolling: "touch" }}
        >
          <label className="clanky-log-filter shrink-0 cursor-pointer text-[11px] sm:text-sm">
            <span className="flex items-center gap-1 whitespace-nowrap sm:gap-2">
              <input
                type="checkbox"
                checked={showSystemInfo}
                onChange={(e) => onShowSystemInfoChange(e.target.checked)}
                aria-label="Show system info"
                className="clanky-log-filter-input rounded"
              />
              <span>System</span>
            </span>
          </label>
          <label className="clanky-log-filter shrink-0 cursor-pointer text-[11px] sm:text-sm">
            <span className="flex items-center gap-1 whitespace-nowrap sm:gap-2">
              <input
                type="checkbox"
                checked={showTools}
                onChange={(e) => onShowToolsChange(e.target.checked)}
                aria-label="Show tools"
                className="clanky-log-filter-input rounded"
              />
              <span>Tools</span>
            </span>
          </label>
        </div>
      </div>
    </div>
  );
}
