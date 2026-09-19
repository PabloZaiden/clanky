import type {
  MessageData,
  TaskLogEntry,
  ToolCallData,
  ToolCallDisplayData,
  WorkspaceFileEntry,
} from "@/shared";
import type { FileExplorerTarget } from "../../hooks/workspaceFileActions";

export interface TranscriptFileLinkTarget {
  /** File path relative to the selected explorer root. */
  path: string;
  /** Explorer root directory that should scope the file open/navigation. */
  startDirectory: string;
  /** Whether the target should open as a file or navigate to a directory root. */
  kind?: "file" | "directory";
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
  /** Load a validated image target into the shared transcript preview. */
  openImagePreview?: (target: TranscriptFileLinkTarget, file: WorkspaceFileEntry) => void;
  /** Surface a click-time validation error to the user. */
  onFileOpenError?: (message: string) => void;
}

export interface ConversationViewerProps {
  /** Conversation messages to display. */
  messages: MessageData[];
  /** Tool calls to display. ToolEntry infers the concrete tool kind from the raw payload shape. */
  toolCalls: ToolCallDisplayData[];
  /** Application logs to display */
  logs?: TaskLogEntry[];
  /** Maximum height */
  maxHeight?: string;
  /** Whether to render conversation content as markdown. */
  markdownEnabled?: boolean;
  /** Whether the task is actively working; active work rows own the spinner when available. Default: false */
  isActive?: boolean;
  /** ID for the root element (for accessibility) */
  id?: string;
  /** Root directory used to display tool file paths relative to the active chat/task context. */
  toolPathDisplayRoot?: string;
  /** Optional chat/task-aware context for turning inline code paths into code explorer links. */
  fileLinkContext?: TranscriptFileLinkContext;
  /** Fetches one full tool-call payload when its row is expanded. */
  onLoadToolDetails?: (toolCallId: string) => Promise<ToolCallData | null>;
  /** Whether older transcript pages are available. */
  hasOlderTranscript?: boolean;
  /** Load the next older transcript page. */
  onLoadMoreTranscript?: () => Promise<void>;
  /** Load the complete transcript history. */
  onLoadFullTranscript?: () => Promise<void>;
  /** Whether a transcript history action is currently loading. */
  loadingTranscript?: boolean;
  /** Start server-side speech playback for a completed assistant message. */
  onReadAloud?: (message: MessageData, mode: "full" | "summary") => void;
  /** Whether the summary playback action is available. */
  readAloudSummaryEnabled?: boolean;
  /** Current message/mode being played, if any. */
  playingReadAloudKey?: string | null;
  /** Current read-aloud lifecycle state. */
  readAloudStatus?: "generating" | "playing" | null;
}

/**
 * Base type for a display entry before render metadata annotation.
 */
export type EntryBase =
  | { type: "message"; data: MessageData; timestamp: string }
  | { type: "tool"; data: ToolCallDisplayData; timestamp: string }
  | {
      type: "log";
      data: TaskLogEntry;
      timestamp: string;
      /** Stable identity of the original consecutive reasoning run. */
      reasoningGroupId?: string;
      /** Timestamp of the first non-reasoning event after this reasoning block. */
      reasoningEndTimestamp?: string;
    };

export interface ToolGroupEntryBase {
  type: "tool-group";
  /** Stable identity for a consecutive run of tool calls. */
  id: string;
  /** Tool calls contained in this consecutive run. */
  tools: ToolCallDisplayData[];
  /** Timestamp of the first tool call in the run. */
  timestamp: string;
  /** Timestamp of the last tool call in the run. */
  lastTimestamp: string;
  /** Whether this is the trailing tool activity with an in-progress call. */
  isActive: boolean;
}

export interface ReasoningGroupEntryBase {
  type: "reasoning-group";
  /** Stable identity for a consecutive run of reasoning logs. */
  id: string;
  /** Reasoning log entries contained in this consecutive run. */
  logs: TaskLogEntry[];
  /** Timestamp of the first reasoning log in the run. */
  timestamp: string;
  /** Timestamp of the last reasoning log in the run. */
  lastTimestamp: string;
  /** Timestamp of the first event after the reasoning run, when available. */
  endedAt?: string;
  /** Whether this run is the currently streaming reasoning block. */
  isActive: boolean;
}

export type WorkingGroupChildEntry = ToolGroupEntryBase | ReasoningGroupEntryBase;

export interface WorkingGroupEntryBase {
  type: "working-group";
  /** Stable identity for a consecutive mixed thinking/tools run. */
  id: string;
  /** Existing tool and reasoning groups contained in this outer group. */
  entries: WorkingGroupChildEntry[];
  /** Timestamp of the first thinking/tool event in the run. */
  timestamp: string;
  /** Timestamp of the last thinking/tool event in the run. */
  lastTimestamp: string;
  /** Timestamp of the first event after the run, when available. */
  endedAt?: string;
  /** Whether this run is the currently streaming mixed activity block. */
  isActive: boolean;
}

export type GroupedEntryBase =
  | EntryBase
  | ToolGroupEntryBase
  | ReasoningGroupEntryBase
  | WorkingGroupEntryBase;

/**
 * Display entry with derived metadata for rendering grouped rows.
 */
export type DisplayEntry = GroupedEntryBase & {
  /** Whether this entry should render its visible timestamp. */
  showTimestamp: boolean;
  /** Whether this entry starts a new grouped row for spacing and labels. */
  showGroupHeader: boolean;
};
