import type { MessageData, ToolCallData, LogLevel } from "../../types";

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
  /** ISO timestamp */
  timestamp: string;
}

export interface LogViewerProps {
  /** Messages to display (only user messages are rendered; assistant messages are filtered out) */
  messages: MessageData[];
  /** Tool calls to display. ToolEntry infers the concrete tool kind from the raw payload shape. */
  toolCalls: ToolCallData[];
  /** Application logs to display */
  logs?: LogEntry[];
  /** Whether to auto-scroll to bottom */
  autoScroll?: boolean;
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
  /** Whether the loop is actively working (shows a spinner at the bottom). Default: false */
  isActive?: boolean;
  /** ID for the root element (for accessibility) */
  id?: string;
  /** Root directory used to display tool file paths relative to the active chat/loop context. */
  toolPathDisplayRoot?: string;
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

/**
 * Display entry with derived metadata for rendering grouped rows.
 */
export type DisplayEntry = EntryBase & {
  /** Whether this entry should render its visible timestamp. */
  showTimestamp: boolean;
  /** Whether this entry starts a new grouped row for spacing and labels. */
  showGroupHeader: boolean;
};
