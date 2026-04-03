/**
 * Schema exports for API request validation.
 *
 * This module re-exports all Zod schemas from a single entry point.
 *
 * @module types/schemas
 */

// Model schemas
export {
  ModelConfigSchema,
  type ModelConfig,
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
  AnswerPlanQuestionRequestSchema,
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
  type SshKeyAlgorithm,
  type CreateSshServerRequest,
  type UpdateSshServerRequest,
  type SshServerEncryptedCredential,
  type SshCredentialExchangeRequest,
  type SshCredentialToken,
  type CreateSshServerSessionRequest,
  type DeleteSshServerSessionRequest,
} from "./ssh-server";

// Provisioning schemas
export {
  CreateProvisioningJobRequestSchema,
  type CreateProvisioningJobRequest,
} from "./provisioning";
