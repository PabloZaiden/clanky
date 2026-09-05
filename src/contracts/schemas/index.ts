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

export {
  ExecutionHostKindSchema,
  ExecutionHostRefSchema,
  ExecutionHostCapabilityIdSchema,
  ExecutionHostCapabilitiesSchema,
  ExecutionNodeConfigurationSchema,
  ExecutionHostAvailabilitySchema,
  ExecutionHostAccessRequirementSchema,
  ExecutionHostBindingSchema,
  ExecutionHostDescriptorSchema,
  UpdateExecutionHostConfigurationSchema,
  ExecutionHostWorkingDirectorySchema,
  ResolveExecutionHostWorkingDirectoryRequestSchema,
  type ExecutionHostRefInput,
  type ExecutionNodeConfigurationInput,
  type ExecutionHostBindingInput,
  type ExecutionHostDescriptorInput,
  type UpdateExecutionHostConfigurationRequest,
  type ExecutionHostWorkingDirectory,
} from "./execution-host";

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
  CreateExecutionHostChatRequestSchema,
  ImportExistingChatRequestSchema,
  DiscoverSshServerChatProvidersRequestSchema,
  DiscoverSshServerChatModelsRequestSchema,
  DiscoverExecutionHostModelsRequestSchema,
  DiscoverExecutionHostProvidersRequestSchema,
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
  WorkspaceTypeSchema,
  AgentSettingsSchema,
  ServerSettingsSchema,
  CreateWorkspaceRequestSchema,
  DeleteWorkspaceRequestSchema,
  UpdateWorkspaceRequestSchema,
  TestConnectionRequestSchema,
  type AgentProvider,
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
  CheckSshServerPrerequisitesRequestSchema,
  GetDevboxTemplatesRequestSchema,
  CreateVncSessionRequestSchema,
  type SshKeyAlgorithm,
  type CreateSshServerRequest,
  type UpdateSshServerRequest,
  type SshServerEncryptedCredential,
  type SshCredentialExchangeRequest,
  type SshCredentialToken,
  type CheckSshServerPrerequisitesRequest,
  type GetDevboxTemplatesRequest,
  type CreateVncSessionRequest,
} from "./ssh-server";

// Provisioning schemas
export {
  CreateProvisioningJobRequestSchema,
  type CreateProvisioningJobRequest,
} from "./provisioning";

// Controller-worker mesh schemas
export {
  MeshTransportSchema,
  MeshEndpointSchema,
  UpdateMeshEndpointSchema,
  UpdateMeshInstanceNameSchema,
  CreateMeshEnrollmentTokenRequestSchema,
  EnrollMeshWorkerRequestSchema,
  RevokeMeshWorkerRequestSchema,
  MeshEnrollmentRequestSchema,
  MeshEnrollmentResponseSchema,
  MeshHealthCheckSchema,
  MeshHealthCheckResponseSchema,
  MeshRevocationNoticeSchema,
  type CreateMeshEnrollmentTokenRequest,
  type EnrollMeshWorkerRequest,
  type RevokeMeshWorkerRequest,
  type MeshEnrollmentRequest,
  type MeshEnrollmentResponse,
  type MeshHealthCheck,
  type MeshHealthCheckResponse,
  type MeshRevocationNotice,
  type UpdateMeshEndpointRequest,
  type UpdateMeshInstanceNameRequest,
} from "./mesh";

export {
  MeshExecutionSessionRequestSchema,
  MeshExecutionRpcRequestSchema,
  type MeshExecutionSessionRequest,
  type MeshExecutionRpcRequest,
} from "./mesh-execution";

export {
  WorkspaceExecRequestSchema,
  WorkspaceExecResponseSchema,
  type WorkspaceExecRequest,
  type WorkspaceExecResponse,
} from "./workspace-execution";

export {
  MeshTerminalSessionRequestSchema,
  MeshTerminalClientFrameSchema,
  MeshTerminalServerFrameSchema,
  type MeshTerminalSessionRequest,
  type MeshTerminalClientFrame,
  type MeshTerminalServerFrame,
} from "./mesh-terminal";

export {
  MeshTcpTunnelSessionRequestSchema,
  type MeshTcpTunnelSessionRequest,
} from "./mesh-tcp-tunnel";
