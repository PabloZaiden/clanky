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

// Loop schemas
export {
  GitConfigSchema,
  LoopNameSchema,
  MessageImageAttachmentSchema,
  MessageImageAttachmentsSchema,
  CreateLoopRequestSchema,
  GenerateLoopTitleRequestSchema,
  UpdateLoopRequestSchema,
  AddressCommentsRequestSchema,
  PlanFeedbackRequestSchema,
  PlanAcceptRequestSchema,
  PendingPromptRequestSchema,
  SetPendingRequestSchema,
  StartDraftRequestSchema,
  FollowUpRequestSchema,
} from "./loop";

// Chat schemas
export {
  CreateChatRequestSchema,
  UpdateChatRequestSchema,
  SendChatMessageRequestSchema,
  InterruptChatRequestSchema,
} from "./chat";

// Workspace schemas
export {
  AgentProviderSchema,
  AgentTransportSchema,
  AgentSettingsSchema,
  ServerSettingsSchema,
  CreateWorkspaceRequestSchema,
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
  type SshKeyAlgorithm,
  type CreateSshServerRequest,
  type UpdateSshServerRequest,
  type SshServerEncryptedCredential,
  type SshCredentialExchangeRequest,
  type SshCredentialToken,
  type CreateSshServerSessionRequest,
  type DeleteSshServerSessionRequest,
  type CheckSshServerPrerequisitesRequest,
} from "./ssh-server";

// Provisioning schemas
export {
  CreateProvisioningJobRequestSchema,
  type CreateProvisioningJobRequest,
} from "./provisioning";
