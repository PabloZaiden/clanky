/**
 * Schema exports for API request validation.
 *
 * This module re-exports all Zod schemas from a single entry point.
 *
 * @module contracts/schemas
 */

export {
  ModelConfigSchema,
  CheapModelSelectionSchema,
  type ModelConfig,
  type CheapModelSelection,
} from "./model";

// Task schemas
export {
  GitConfigSchema,
  TaskNameSchema,
  IssueNumberSchema,
  MessageImageAttachmentSchema,
  MessageImageAttachmentsSchema,
  CreateTaskRequestSchema,
  GenerateTaskTitleRequestSchema,
  UpdateTaskRequestSchema,
  AddressCommentsRequestSchema,
  PlanFeedbackRequestSchema,
  PlanAcceptRequestSchema,
  PendingPromptRequestSchema,
  SetPendingRequestSchema,
  StartDraftRequestSchema,
  FollowUpRequestSchema,
} from "./task";

// Chat schemas
export {
  CreateChatRequestSchema,
  CreateSshServerChatRequestSchema,
  ImportExistingChatRequestSchema,
  DiscoverSshServerChatProvidersRequestSchema,
  DiscoverSshServerChatModelsRequestSchema,
  UpdateChatRequestSchema,
  SendChatMessageRequestSchema,
  InterruptChatRequestSchema,
  ReplyToChatPermissionRequestSchema,
  ReconnectChatRequestSchema,
  SpawnCurrentPlanTaskRequestSchema,
} from "./chat";

// Agent schemas
export {
  AgentScheduleIntervalUnitSchema,
  AgentScheduleIntervalSchema,
  AgentScheduleSchema,
  CreateAgentRequestSchema,
  UpdateAgentRequestSchema,
  RunAgentRequestSchema,
  DeleteAgentRunsRequestSchema,
  AgentRunsQuerySchema,
  SchedulerTimezoneRequestSchema,
  type CreateAgentRequest,
  type UpdateAgentRequest,
  type RunAgentRequest,
  type DeleteAgentRunsRequest,
  type AgentRunsQuery,
  type SchedulerTimezoneRequest,
} from "./agent";

// Workspace schemas
export {
  AgentProviderSchema,
  AgentTransportSchema,
  AgentSettingsSchema,
  ServerSettingsSchema,
  CreateWorkspaceRequestSchema,
  DeleteWorkspaceRequestSchema,
  UpdateWorkspaceRequestSchema,
  TestConnectionRequestSchema,
  type AgentProvider,
  type AgentTransport,
  type AgentSettings,
  type ServerSettings,
  type CreateWorkspaceRequest,
  type UpdateWorkspaceRequest,
  type DeleteWorkspaceRequest,
} from "./workspace";

// Preferences schemas
export {
  SetLastModelRequestSchema,
  SetLastCheapModelRequestSchema,
  SetLastDirectoryRequestSchema,
  SetMarkdownRenderingRequestSchema,
  SetFileExplorerFullTreeRequestSchema,
  SetDashboardViewModeRequestSchema,
  SetSchedulerTimezoneRequestSchema,
  QuickChatSettingsSchema,
  SetQuickChatSettingsRequestSchema,
  normalizeQuickChatSettings,
} from "./preferences";

// SSH session schemas
export {
  CreateSshSessionRequestSchema,
  UpdateSshSessionRequestSchema,
} from "./ssh-session";

// Shared file explorer schemas
export {
  FileExplorerRelativePathSchema,
  FileExplorerStartDirectorySchema,
  ListFileExplorerRequestSchema,
  GetFileExplorerTreeRequestSchema,
  GetFileExplorerFileRequestSchema,
  WriteFileExplorerRequestSchema,
  RenameFileExplorerRequestSchema,
  DeleteFileExplorerRequestSchema,
  CreateFileExplorerUploadRequestSchema,
  UploadFileExplorerChunkRequestSchema,
  CompleteFileExplorerUploadRequestSchema,
  CancelFileExplorerUploadRequestSchema,
} from "./file-explorer";

// Standalone SSH server schemas
export {
  SshKeyAlgorithmSchema,
  CreateSshServerRequestSchema,
  UpdateSshServerRequestSchema,
  SshServerEncryptedCredentialSchema,
  SshCredentialExchangeRequestSchema,
  SshCredentialTokenSchema,
  CreateSshServerSessionRequestSchema,
  DeleteSshServerSessionRequestSchema,
  CheckSshServerPrerequisitesRequestSchema,
  GetDevboxTemplatesRequestSchema,
  CreateVncSessionRequestSchema,
  type SshKeyAlgorithm,
  type CreateSshServerRequest,
  type UpdateSshServerRequest,
  type SshServerEncryptedCredential,
  type SshCredentialExchangeRequest,
  type SshCredentialToken,
  type CreateSshServerSessionRequest,
  type DeleteSshServerSessionRequest,
  type CheckSshServerPrerequisitesRequest,
  type GetDevboxTemplatesRequest,
  type CreateVncSessionRequest,
} from "./ssh-server";

// Provisioning schemas
export {
  CreateProvisioningJobRequestSchema,
  type CreateProvisioningJobRequest,
} from "./provisioning";
