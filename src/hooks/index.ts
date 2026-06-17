/**
 * Central export for all hooks.
 */

export { useWebSocket, useGlobalEvents, useTaskEvents, type WebSocketConnectionStatus, type UseWebSocketOptions, type UseWebSocketResult } from "./useWebSocket";
export { AppEventsProvider, isAgentEvent, isChatEvent, isTaskEvent, isSshSessionEvent, useAppEvents } from "./useAppEvents";
export { useChats, type UseChatsResult } from "./useChats";
export { useAgents, type UseAgentsResult } from "./useAgents";
export { useTasks, type UseTasksResult, type CreateTaskResult } from "./useTasks";
export { useTask, type UseTaskResult } from "./useTask";
export { useSshSessions, type UseSshSessionsResult } from "./useSshSessions";
export { useSshSession, type UseSshSessionResult } from "./useSshSession";
export { useSshServers, type UseSshServersResult } from "./useSshServers";
export { useTaskPortForwards, type UseTaskPortForwardsResult } from "./useTaskPortForwards";
export { useWorkspaceServerSettings, type UseWorkspaceServerSettingsResult } from "./useWorkspaceServerSettings";
export { useMarkdownPreference, type UseMarkdownPreferenceResult } from "./useMarkdownPreference";
export {
  ThemePreferenceProvider,
  useThemePreference,
  type UseThemePreferenceResult,
} from "./useThemePreference";
export {
  useFileExplorerFullTreePreference,
  type UseFileExplorerFullTreePreferenceResult,
} from "./useFileExplorerFullTreePreference";
export { useLogLevelPreference, type UseLogLevelPreferenceResult } from "./useLogLevelPreference";
export { useQuickChatSettings, type UseQuickChatSettingsResult } from "./useQuickChatSettings";
export { useWorkspaces, type UseWorkspacesResult } from "./useWorkspaces";
export { useAgentsMdOptimizer, type UseAgentsMdOptimizerResult, type AgentsMdStatus, type OptimizeResult } from "./useAgentsMdOptimizer";
export { useCountdownReload, computeProgressPercent, KILL_SERVER_COUNTDOWN_SECONDS, type UseCountdownReloadResult } from "./useCountdownReload";
export { useToast, type ToastContextValue, type Toast, type ToastOptions } from "./useToast";
export { usePasskeyAuth, type UsePasskeyAuthResult } from "./usePasskeyAuth";
export { useTaskGrouping, groupTasksByStatus, sectionConfig, type StatusGroups, type StatusSectionKey, type SectionConfig, type WorkspaceGroup, type UseTaskGroupingResult } from "./useTaskGrouping";
export { useDashboardModals, type ModalState, type UncommittedModalState, type UseDashboardModalsResult } from "./useDashboardModals";
export { useDashboardData, type UseDashboardDataResult } from "./useDashboardData";
export { useViewModePreference, type UseViewModePreferenceResult, type DashboardViewMode } from "./useViewModePreference";
export { useProvisioningJob, type UseProvisioningJobResult, type StartProvisioningJobRequest } from "./useProvisioningJob";
export {
  useAvailableModels,
  type UseAvailableModelsOptions,
  type UseAvailableModelsResult,
} from "./useAvailableModels";
export {
  useDevboxTemplates,
  type UseDevboxTemplatesOptions,
  type UseDevboxTemplatesResult,
} from "./useDevboxTemplates";
export {
  useFileExplorer,
  useWorkspaceFiles,
  useServerFiles,
  type UseFileExplorerResult,
  type UseWorkspaceFilesResult,
  type WorkspaceFileConflictState,
} from "./useWorkspaceFiles";
// Shared task action API functions
export {
  acceptTaskApi,
  pushTaskApi,
  createTaskPortForwardApi,
  deleteTaskPortForwardApi,
  listTaskPortForwardsApi,
  updateBranchApi,
  stopTaskApi,
  discardTaskApi,
  deleteTaskApi,
  purgeTaskApi,
  manualCompleteTaskApi,
  purgeArchivedWorkspaceTasksApi,
  purgeTerminalTasksApi,
  getTaskSshSessionApi,
  getOrCreateTaskSshSessionApi,
  setPendingPromptApi,
  clearPendingPromptApi,
  markMergedApi,
  sendPlanFeedbackApi,
  acceptPlanApi,
  discardPlanApi,
  addressReviewCommentsApi,
  sendFollowUpApi,
  setPendingApi,
  clearPendingApi,
  type CreatePortForwardRequest,
  type AcceptTaskResult,
  type PushTaskResult,
  type AddressCommentsResult,
  type SetPendingResult,
  type PurgeArchivedTasksResult,
  type PurgeTerminalTasksResult,
} from "./taskActions";
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
  type FileExplorerTarget,
  WorkspaceFileConflictError,
  listFileExplorerFilesApi,
  readFileExplorerFileApi,
  downloadFileExplorerFileApi,
  getFileExplorerDownloadUrl,
  getFileExplorerFileMetadataApi,
  writeFileExplorerFileApi,
  listWorkspaceFilesApi,
  readWorkspaceFileApi,
  downloadWorkspaceFileApi,
  getWorkspaceFileMetadataApi,
  writeWorkspaceFileApi,
  listServerFilesApi,
  readServerFileApi,
  downloadServerFileApi,
  getServerFileMetadataApi,
  writeServerFileApi,
} from "./workspaceFileActions";
