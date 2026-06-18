/**
 * Schema exports for API request validation.
 *
 * This module re-exports all Zod schemas from a single entry point.
 *
 * @module types/schemas
 */

// Model schemas
export {
  DeviceStartRequestSchema,
  DeviceVerificationActionSchema,
  RefreshGrantSchema,
  RefreshEndpointRequestSchema,
  DeviceGrantSchema,
  TokenRequestSchema,
  PublicRevokeRequestSchema,
  IssuerSettingsSchema,
} from "./auth";

export {
  CompletePasskeyRegistrationRequestSchema,
  CompletePasskeyAuthenticationRequestSchema,
} from "./passkey-auth";

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
  WorkspaceConfigSchema,
  WorkspaceExportSchema,
  WorkspaceImportRequestSchema,
  type AgentProvider,
  type AgentTransport,
  type AgentSettings,
  type ServerSettings,
  type WorkspaceConfig,
  type WorkspaceExportData,
  type WorkspaceImportRequest,
  type DeleteWorkspaceRequest,
} from "./workspace";

// Preferences schemas
export {
  SetLastModelRequestSchema,
  SetLastCheapModelRequestSchema,
  SetLastDirectoryRequestSchema,
  SetMarkdownRenderingRequestSchema,
  SetFileExplorerFullTreeRequestSchema,
  SetLogLevelRequestSchema,
  SetDashboardViewModeRequestSchema,
  SetThemePreferenceRequestSchema,
  SetSchedulerTimezoneRequestSchema,
  QuickChatSettingsSchema,
  SetQuickChatSettingsRequestSchema,
  normalizeQuickChatSettings,
} from "./preferences";

// SSH session schemas
export {
  CreateSshSessionRequestSchema,
  UpdateSshSessionRequestSchema,
  CreatePortForwardRequestSchema,
} from "./ssh-session";

// Workspace file explorer schemas
export {
  WorkspaceRelativePathSchema,
  WorkspaceStartDirectorySchema,
  ListWorkspaceFilesRequestSchema,
  GetWorkspaceFileTreeRequestSchema,
  GetWorkspaceFileRequestSchema,
  WriteWorkspaceFileRequestSchema,
  RenameWorkspaceFileRequestSchema,
  DeleteWorkspaceFileRequestSchema,
  CreateWorkspaceFileUploadRequestSchema,
  UploadWorkspaceFileChunkRequestSchema,
  CompleteWorkspaceFileUploadRequestSchema,
  CancelWorkspaceFileUploadRequestSchema,
} from "./workspace-files";

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
