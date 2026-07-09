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
export { normalizeCommitScope } from "./commit-scope";

export { formatFileSize, formatRelativeTime } from "./format";

export { buildDefaultSshSessionName, buildTaskSshSessionName } from "./ssh-session-name";

export { writeTextToClipboard } from "./clipboard";

export { buildPreviewCliCommand, getPreviewWorkspaceReference } from "./preview-command";

export {
  getEffectiveSshConnectionMode,
  getSshConnectionModeLabel,
  isPersistentSshConnectionMode,
  isPersistentSshSession,
} from "./ssh-connection-mode";
