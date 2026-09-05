/**
 * Central export for all utility functions.
 */

export {
  getStatusLabel,
  canAccept,
  canMarkMerged,
  canManualComplete,
  isFinalState,
  isTaskActive,
  isTaskRunning,
  isTaskGenerating,
  canJumpstart,
  canSendTerminalFollowUp,
  isAwaitingFeedback,
  isArchivedTask,
  isWorkspaceHistoryTask,
  shouldShowInRecentActivity,
  getRecentActivityTimestamp,
  getPlanningStatusLabel,
  getTaskStatusLabel,
  getTaskStatusPill,
  getTaskStatusPillFromState,
  isTaskPlanReady,
  getEntityLabel,
  type EntityLabels,
  type TaskStatusPill,
  type TaskStatusPillKey,
  type TaskStatusPillVariant,
} from "./task-status";

export { sanitizeBranchName } from "./sanitize-branch-name";
export { formatFileSize, formatRelativeTime } from "./format";


export { readClipboardContent, writeTextToClipboard, type ClipboardReadResult } from "./clipboard";

export { buildPreviewCliCommand, getPreviewWorkspaceReference } from "./preview-command";

export {
  getEffectiveTerminalConnectionMode,
  getTerminalConnectionModeLabel,
  isPersistentTerminalConnectionMode,
  isPersistentTerminalSession,
} from "./terminal-connection-mode";
