/**
 * Central export for all utility functions.
 */

export {
  getStatusLabel,
  canAccept,
  canMarkMerged,
  canManualComplete,
  isFinalState,
  isLoopActive,
  isLoopRunning,
  isLoopGenerating,
  canJumpstart,
  canSendTerminalFollowUp,
  isAwaitingFeedback,
  isArchivedLoop,
  isWorkspaceHistoryLoop,
  shouldShowInRecentActivity,
  getPlanningStatusLabel,
  getLoopStatusLabel,
  isLoopPlanReady,
  getEntityLabel,
  type EntityLabels,
} from "./loop-status";

export { sanitizeBranchName } from "./sanitize-branch-name";
export { normalizeCommitScope } from "./commit-scope";

export { formatRelativeTime } from "./format";

export { buildDefaultSshSessionName, buildLoopSshSessionName } from "./ssh-session-name";

export { writeTextToClipboard } from "./clipboard";

export {
  getEffectiveSshConnectionMode,
  getSshConnectionModeLabel,
  isPersistentSshConnectionMode,
  isPersistentSshSession,
} from "./ssh-connection-mode";
