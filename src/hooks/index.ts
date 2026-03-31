/**
 * Central export for all hooks.
 */

export { useWebSocket, useGlobalEvents, useLoopEvents, type WebSocketConnectionStatus, type UseWebSocketOptions, type UseWebSocketResult } from "./useWebSocket";
export { useChats, type UseChatsResult } from "./useChats";
export { useLoops, type UseLoopsResult, type CreateLoopResult } from "./useLoops";
export { useLoop, type UseLoopResult } from "./useLoop";
export { useSshSessions, type UseSshSessionsResult } from "./useSshSessions";
export { useSshSession, type UseSshSessionResult } from "./useSshSession";
export { useSshServers, type UseSshServersResult } from "./useSshServers";
export { useLoopPortForwards, type UseLoopPortForwardsResult } from "./useLoopPortForwards";
export { useWorkspaceServerSettings, type UseWorkspaceServerSettingsResult } from "./useWorkspaceServerSettings";
export { useMarkdownPreference, type UseMarkdownPreferenceResult } from "./useMarkdownPreference";
export { useLogLevelPreference, type UseLogLevelPreferenceResult } from "./useLogLevelPreference";
export { useWorkspaces, type UseWorkspacesResult } from "./useWorkspaces";
export { useAgentsMdOptimizer, type UseAgentsMdOptimizerResult, type AgentsMdStatus, type OptimizeResult } from "./useAgentsMdOptimizer";
export { useCountdownReload, computeProgressPercent, KILL_SERVER_COUNTDOWN_SECONDS, type UseCountdownReloadResult } from "./useCountdownReload";
export { useToast, type ToastContextValue, type Toast, type ToastType, type ToastOptions } from "./useToast";
export { useLoopGrouping, groupLoopsByStatus, sectionConfig, type StatusGroups, type StatusSectionKey, type SectionConfig, type WorkspaceGroup, type UseLoopGroupingResult } from "./useLoopGrouping";
export { useDashboardModals, type ModalState, type UncommittedModalState, type UseDashboardModalsResult } from "./useDashboardModals";
export { useDashboardData, type UseDashboardDataResult } from "./useDashboardData";
export { useViewModePreference, type UseViewModePreferenceResult, type DashboardViewMode } from "./useViewModePreference";
export { useProvisioningJob, type UseProvisioningJobResult, type StartProvisioningJobRequest } from "./useProvisioningJob";
export { useWorkspaceFiles, type UseWorkspaceFilesResult, type WorkspaceFileConflictState } from "./useWorkspaceFiles";
// Shared loop action API functions
export {
  acceptLoopApi,
  pushLoopApi,
  createLoopPortForwardApi,
  deleteLoopPortForwardApi,
  listLoopPortForwardsApi,
  updateBranchApi,
  stopLoopApi,
  discardLoopApi,
  deleteLoopApi,
  purgeLoopApi,
  purgeArchivedWorkspaceLoopsApi,
  getLoopSshSessionApi,
  getOrCreateLoopSshSessionApi,
  setPendingPromptApi,
  clearPendingPromptApi,
  markMergedApi,
  sendPlanFeedbackApi,
  answerPlanQuestionApi,
  acceptPlanApi,
  discardPlanApi,
  addressReviewCommentsApi,
  sendFollowUpApi,
  setPendingApi,
  clearPendingApi,
  type CreatePortForwardRequest,
  type AcceptLoopResult,
  type PushLoopResult,
  type AddressCommentsResult,
  type SetPendingResult,
  type PurgeArchivedLoopsResult,
} from "./loopActions";
export {
  getSshServerApi,
  createSshServerApi,
  updateSshServerApi,
  deleteSshServerApi,
  createStandaloneSshSessionApi,
  deleteStandaloneSshSessionApi,
  saveStandaloneSshServerPassword,
} from "./sshServerActions";
export {
  WorkspaceFileConflictError,
  listWorkspaceFilesApi,
  readWorkspaceFileApi,
  getWorkspaceFileMetadataApi,
  writeWorkspaceFileApi,
} from "./workspaceFileActions";
