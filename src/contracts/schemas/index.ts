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
  MessageAttachmentSchema,
  MessageAttachmentsSchema,
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
  GenerateAgentCodeRequestSchema,
  PrepareGenerateAgentCodeRequestSchema,
  TestAgentCodeRequestSchema,
  RunAgentRequestSchema,
  DeleteAgentRunsRequestSchema,
  AgentRunsQuerySchema,
  SchedulerTimezoneRequestSchema,
  type CreateAgentRequest,
  type UpdateAgentRequest,
  type GenerateAgentCodeRequest,
  type PrepareGenerateAgentCodeRequest,
  type TestAgentCodeRequest,
  type RunAgentRequest,
  type DeleteAgentRunsRequest,
  type AgentRunsQuery,
  type SchedulerTimezoneRequest,
} from "./agent";

// Workspace schemas
export {
  AgentProviderSchema,
  AgentTransportSchema,
  WorkspaceTypeSchema,
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

// Terminal session schemas
export {
  TerminalConnectionModeSchema,
  CreateTerminalSessionRequestSchema,
  UpdateTerminalSessionRequestSchema,
} from "./terminal-session";

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

// Linked-instance mesh schemas
export {
  MeshTransportSchema,
  MeshPairingDirectionSchema,
  MeshEndpointSchema,
  UpdateMeshEndpointSchema,
  StartMeshPairingRequestSchema,
  ApproveMeshPairingRequestSchema,
  RejectMeshPairingRequestSchema,
  CompleteMeshPairingRequestSchema,
  RevokeMeshMemberRequestSchema,
  MeshPeerPairingRequestSchema,
  MeshPeerPairingApprovalSchema,
  MeshMembershipUpdateSchema,
  MeshHealthCheckSchema,
  type StartMeshPairingRequest,
  type ApproveMeshPairingRequest,
  type RejectMeshPairingRequest,
  type CompleteMeshPairingRequest,
  type MeshPeerPairingRequest,
  type MeshPeerPairingApproval,
  type MeshMembershipUpdate,
  type MeshHealthCheck,
  type UpdateMeshEndpointRequest,
} from "./mesh";

export {
  MeshExecutionSessionRequestSchema,
  MeshExecutionRpcRequestSchema,
  type MeshExecutionSessionRequest,
  type MeshExecutionRpcRequest,
} from "./mesh-execution";

export {
  MeshTerminalSessionRequestSchema,
  MeshTerminalClientFrameSchema,
  MeshTerminalServerFrameSchema,
  type MeshTerminalSessionRequest,
  type MeshTerminalClientFrame,
  type MeshTerminalServerFrame,
} from "./mesh-terminal";
