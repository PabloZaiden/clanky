import type { MessageData, ToolCallData, LogLevel } from "../../types";
import type { FileExplorerTarget } from "../../hooks/workspaceFileActions";
import type { PromiseMarkerOutcomeKind } from "../../utils/promise-markers";

/**
 * Application log entry for display in the UI.
 */
export interface LogEntry {
  /** Unique ID for the log entry */
  id: string;
  /** Log level */
  level: LogLevel;
  /** Log message */
  message: string;
  /** Optional additional details */
  details?: Record<string, unknown>;
  /** Optional finalized-response metadata derived once the assistant message completes. */
  finalizedResponse?: FinalizedResponseLogData;
  /** ISO timestamp */
  timestamp: string;
}

export interface FinalizedResponseIndicator {
  /** Raw promise marker value that was detected. */
  marker: string;
  /** Normalized semantic kind for UI styling. */
  kind: PromiseMarkerOutcomeKind;
  /** Human-readable label for the UI indicator. */
  label: string;
}

export interface FinalizedResponseLogData {
  /** Response content with the trailing promise marker removed. */
  content: string;
  /** UI indicator metadata for the detected marker. */
  indicator: FinalizedResponseIndicator;
}

export interface TranscriptFileLinkTarget {
  /** File path relative to the selected explorer root. */
  path: string;
  /** Explorer root directory that should scope the file open/navigation. */
  startDirectory: string;
}

export interface TranscriptFileLinkContext {
  /** Explorer target used for async metadata lookups. */
  fileExplorerTarget: FileExplorerTarget;
  /** Effective root directory for absolute-path normalization. */
  rootDirectory: string;
  /** Build the hash href for a resolved file link. */
  getFileHref: (target: TranscriptFileLinkTarget) => string;
  /** Navigate to the resolved file in the code explorer. */
  openFile: (target: TranscriptFileLinkTarget) => void;
  /** Surface a click-time validation error to the user. */
  onFileOpenError?: (message: string) => void;
}

export interface LogViewerProps {
  /** Messages to display (only user messages are rendered; assistant messages are filtered out) */
  messages: MessageData[];
  /** Tool calls to display. ToolEntry infers the concrete tool kind from the raw payload shape. */
  toolCalls: ToolCallData[];
  /** Application logs to display */
  logs?: LogEntry[];
  /** Maximum height */
  maxHeight?: string;
  /** Whether to show system information logs (info, warn, error, debug, trace, system agent messages). Default: false */
  showSystemInfo?: boolean;
  /** Whether to show reasoning entries ("AI reasoning..." logs). Default: true */
  showReasoning?: boolean;
  /**
   * Whether to show tool-related entries derived from `toolCalls` (ToolEntry rows).
   * Legacy tool-related agent log messages (e.g. logKind="tool" or messages starting
   * with "AI calling tool:") are always hidden by the log viewer. Default: true
   */
  showTools?: boolean;
  /** Whether to render response log content as markdown (default: false) */
  markdownEnabled?: boolean;
  /** Whether the task is actively working (shows a spinner at the bottom). Default: false */
  isActive?: boolean;
  /** ID for the root element (for accessibility) */
  id?: string;
  /** Root directory used to display tool file paths relative to the active chat/task context. */
  toolPathDisplayRoot?: string;
  /** Optional chat/task-aware context for turning inline code paths into code explorer links. */
  fileLinkContext?: TranscriptFileLinkContext;
  /** Optional surface class override for the scroll container that owns the transcript background. */
  surfaceClassName?: string;
  /** Optional class override for the inner transcript wrapper. */
  transcriptClassName?: string;
}

export interface ConversationViewerProps extends LogViewerProps {
  /** Whether assistant messages should be rendered alongside user messages. Default: false */
  showAssistantMessages?: boolean;
  /** Whether response log entries should be rendered. Default: true */
  showResponseLogs?: boolean;
  /** Whether to show explicit role labels above message content. Default: false */
  showMessageRoles?: boolean;
  /** Empty state copy to show when there are no visible entries. */
  emptyStateMessage?: string;
  /** Active-state copy to show while the transcript is still streaming. */
  activeStateMessage?: string;
}

/**
 * Base type for a display entry before render metadata annotation.
 */
export type EntryBase =
  | { type: "message"; data: MessageData; timestamp: string }
  | { type: "tool"; data: ToolCallData; timestamp: string }
  | { type: "log"; data: LogEntry; timestamp: string };

export interface ToolGroupEntryBase {
  type: "tool-group";
  /** Stable identity for a consecutive run of tool calls. */
  id: string;
  /** Tool calls contained in this consecutive run. */
  tools: ToolCallData[];
  /** Timestamp of the first tool call in the run. */
  timestamp: string;
  /** Timestamp of the last tool call in the run. */
  lastTimestamp: string;
}

export type GroupedEntryBase = EntryBase | ToolGroupEntryBase;

/**
 * Display entry with derived metadata for rendering grouped rows.
 */
export type DisplayEntry = GroupedEntryBase & {
  /** Whether this entry should render its visible timestamp. */
  showTimestamp: boolean;
  /** Whether this entry starts a new grouped row for spacing and labels. */
  showGroupHeader: boolean;
};
