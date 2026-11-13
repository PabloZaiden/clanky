/**
 * API request and response types for Clanky.
 * 
 * These types define the request and response shapes for the REST API.
 * They are used for type safety in both the API route handlers and clients.
 * 
 * Request types for validated endpoints are derived from Zod schemas,
 * making the schemas the single source of truth for both runtime validation
 * and TypeScript types.
 * 
 * @module contracts/api
 */

import type {
  Chat,
  WorkspaceFileEntry,
  WorkspaceFileKind,
  WorkspaceFileNode,
} from "@/shared";
import {
  CreateChatRequestSchema,
  CreateExecutionHostChatRequestSchema,
  ExecutionHostWorkingDirectorySchema,
  InterruptChatRequestSchema,
  ReplyToChatPermissionRequestSchema,
  ReconnectChatRequestSchema,
  SendChatMessageRequestSchema,
  UpdateChatRequestSchema,
  CheckExecutionHostPrerequisitesRequestSchema,
  GetDevboxTemplatesRequestSchema,
  CreateWorkspaceRequestSchema,
  UpdateWorkspaceRequestSchema,
  DeleteWorkspaceRequestSchema,
  CreateProvisioningJobRequestSchema,
  StartWorkerUpdatesResponseSchema,
  StartWorkerUpdatesRequestSchema,
  WorkerUpdateJobsResponseSchema,
  WorkerUpdateJobSnapshotSchema,
  DismissWorkerUpdateJobResponseSchema,
  RestartAutomaticWorkspacesRequestSchema,
  RestartAutomaticWorkspacesResultSchema,
  RestartAutomaticWorkspacesResponseSchema,
  CreateTerminalSessionRequestSchema,
  UpdateTerminalSessionRequestSchema,
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
  ExecutionHostExecRequestSchema,
  ExecutionHostExecResponseSchema,
  WorkspaceExecRequestSchema,
  WorkspaceExecResponseSchema,
} from "./schemas";
import type { z } from "zod";
import type { ReplyToChatQuestionRequestSchema } from "./schemas/harness";

export type RestartAutomaticWorkspacesRequest =
  z.infer<typeof RestartAutomaticWorkspacesRequestSchema>;
export type RestartAutomaticWorkspacesResult =
  z.infer<typeof RestartAutomaticWorkspacesResultSchema>;
export type RestartAutomaticWorkspacesResponse =
  z.infer<typeof RestartAutomaticWorkspacesResponseSchema>;
export type StartWorkerUpdatesResponse =
  z.infer<typeof StartWorkerUpdatesResponseSchema>;
export type StartWorkerUpdatesRequest =
  z.infer<typeof StartWorkerUpdatesRequestSchema>;
export type WorkerUpdateJobsResponse =
  z.infer<typeof WorkerUpdateJobsResponseSchema>;
export type WorkerUpdateJobSnapshotResponse =
  z.infer<typeof WorkerUpdateJobSnapshotSchema>;
export type DismissWorkerUpdateJobResponse =
  z.infer<typeof DismissWorkerUpdateJobResponseSchema>;

/**
 * Response from GET /api/config.
 */
export interface AppConfig {
  appName?: string;
  version?: string;
  /** Whether remote-only mode is enabled */
  remoteOnly: boolean;
  /** Current passkey-auth status for the requesting browser */
  passkeyAuth?: PasskeyAuthStatusResponse;
  /** Public base path inferred from reverse-proxy headers, if any */
  publicBasePath: string | null;
}

export interface PasskeyAuthStatusResponse {
  /** Whether passkey auth is enabled */
  enabled?: boolean;
  /** Whether a passkey is configured in the app */
  passkeyConfigured: boolean;
  /** Whether passkey enforcement is disabled by env */
  passkeyDisabled: boolean;
  /** Whether this browser currently needs a passkey session to access protected data */
  passkeyRequired: boolean;
  /** Whether the current browser holds a valid passkey session cookie */
  authenticated: boolean;
  /** Whether first owner setup is required */
  bootstrapRequired?: boolean;
  /** Whether owner passkey setup is required after passkey deletion */
  ownerPasskeySetupRequired?: boolean;
}

/**
 * Branch information returned by the git API.
 */
export interface BranchInfo {
  /** Branch or remote-tracking ref name (e.g., "main", "feature/auth", "origin/feature/auth") */
  name: string;
  /** Whether this is the currently checked out local branch */
  current: boolean;
}

/**
 * Response from GET /api/git/github-repository-url.
 */
export interface GitHubRepositoryUrlResponse {
  /** Normalized GitHub repository URL, or null when the repository is not hosted on GitHub */
  githubUrl: string | null;
}

/**
 * A minimal open GitHub issue returned by GET /api/git/github-issues.
 */
export interface GitHubIssueSummary {
  /** Issue number */
  number: number;
  /** Issue title */
  title: string;
}

/**
 * Response from GET /api/git/github-issues.
 */
export interface GitHubIssuesResponse {
  issues: GitHubIssueSummary[];
}

/**
 * Response from GET /api/git/remote-status.
 */
export interface GitRemoteStatusResponse {
  /** Remote name that was checked */
  remote: string;
  /** Whether the requested remote is configured for the repository */
  hasRemote: boolean;
}

/**
 * Model information returned by the GET /api/models endpoint.
 * Includes provider and model details with connection status.
 */
export interface ModelInfo {
  /** Provider ID (e.g., "anthropic", "openai", "bedrock") */
  providerID: string;
  /** Provider display name (e.g., "Anthropic", "OpenAI") */
  providerName: string;
  /** Model ID (e.g., "claude-sonnet-4-20250514", "gpt-4o") */
  modelID: string;
  /** Model display name (e.g., "Claude Sonnet 4", "GPT-4o") */
  modelName: string;
  /** Whether the provider/backend is currently connected and available */
  connected: boolean;
  /**
   * Available variants for this model.
   * Provider-native option identifiers, including reasoning effort levels.
   * An empty string ("") represents the default/no-variant option.
   * If undefined or empty, the model has no variants.
   */
  variants?: string[];
}

export type CreateChatRequest = z.infer<typeof CreateChatRequestSchema>;
export type CreateExecutionHostChatRequest = z.infer<typeof CreateExecutionHostChatRequestSchema>;
export type ExecutionHostWorkingDirectory = z.infer<typeof ExecutionHostWorkingDirectorySchema>;

export type UpdateChatRequest = z.infer<typeof UpdateChatRequestSchema>;
export type SendChatMessageRequest = z.infer<typeof SendChatMessageRequestSchema>;
export type InterruptChatRequest = z.infer<typeof InterruptChatRequestSchema>;
export type ReplyToChatPermissionRequest = z.infer<typeof ReplyToChatPermissionRequestSchema>;
export type ReplyToChatQuestionRequest = z.infer<typeof ReplyToChatQuestionRequestSchema>;
export type ReconnectChatRequest = z.infer<typeof ReconnectChatRequestSchema>;
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequestSchema>;
export type DeleteWorkspaceRequest = z.infer<typeof DeleteWorkspaceRequestSchema>;
export type CreateProvisioningJobRequest = z.infer<typeof CreateProvisioningJobRequestSchema>;
export type WorkspaceExecRequest = z.infer<typeof WorkspaceExecRequestSchema>;
export type WorkspaceExecResponse = z.infer<typeof WorkspaceExecResponseSchema>;
export type ExecutionHostExecRequest = z.infer<typeof ExecutionHostExecRequestSchema>;
export type ExecutionHostExecResponse = z.infer<typeof ExecutionHostExecResponseSchema>;

export type ListChatsResponse = Chat[];

export type ListFileExplorerRequest = z.input<typeof ListFileExplorerRequestSchema>;
export type GetFileExplorerTreeRequest = z.input<typeof GetFileExplorerTreeRequestSchema>;
export type GetFileExplorerFileRequest = z.input<typeof GetFileExplorerFileRequestSchema>;
export type WriteFileExplorerRequest = z.input<typeof WriteFileExplorerRequestSchema>;
export type RenameFileExplorerRequest = z.input<typeof RenameFileExplorerRequestSchema>;
export type DeleteFileExplorerRequest = z.input<typeof DeleteFileExplorerRequestSchema>;
export type CreateFileExplorerUploadRequest = z.input<typeof CreateFileExplorerUploadRequestSchema>;
export type UploadFileExplorerChunkRequest = z.input<typeof UploadFileExplorerChunkRequestSchema>;
export type CompleteFileExplorerUploadRequest = z.input<typeof CompleteFileExplorerUploadRequestSchema>;
export type CancelFileExplorerUploadRequest = z.input<typeof CancelFileExplorerUploadRequestSchema>;

export interface FileExplorerListData {
  directory: string;
  entries: WorkspaceFileNode[];
}

export interface FileExplorerTreeData {
  entriesByDirectory: Record<string, WorkspaceFileNode[]>;
}

export interface FileExplorerReadData {
  file: WorkspaceFileEntry;
  content: string;
}

export interface FileExplorerMetadataData {
  file: WorkspaceFileEntry;
}

export interface FileExplorerWriteData {
  success: true;
  file: WorkspaceFileEntry;
  overwritten: boolean;
}

export interface FileExplorerRenameData {
  success: true;
  file: WorkspaceFileEntry;
  previousPath: string;
  overwritten: boolean;
}

export interface FileExplorerDeleteData {
  success: true;
  deletedPath: string;
  kind: WorkspaceFileKind;
}

export interface FileExplorerUploadCreateData {
  uploadId: string;
  path: string;
  directory: string;
  fileName: string;
  size: number;
}

export interface FileExplorerUploadChunkData {
  success: true;
  uploadId: string;
  bytesWritten: number;
  nextOffset: number;
}

export interface FileExplorerUploadCompleteData {
  success: true;
  file: WorkspaceFileEntry;
  overwritten: boolean;
}

export interface FileExplorerUploadCancelData {
  uploadId: string;
}

export interface WorkspaceFileListResponse extends FileExplorerListData {
  workspaceId: string;
}

export interface WorkspaceFileTreeResponse extends FileExplorerTreeData {
  workspaceId: string;
}

export interface WorkspaceFileReadResponse extends FileExplorerReadData {
  workspaceId: string;
}

export interface WorkspaceFileMetadataResponse extends FileExplorerMetadataData {
  workspaceId: string;
}

export interface WorkspaceFileWriteResponse extends FileExplorerWriteData {
  workspaceId: string;
}

export interface WorkspaceFileRenameResponse extends FileExplorerRenameData {
  workspaceId: string;
}

export interface WorkspaceFileDeleteResponse extends FileExplorerDeleteData {
  workspaceId: string;
}

export interface WorkspaceFileUploadCreateResponse extends FileExplorerUploadCreateData {
  workspaceId: string;
}

export interface WorkspaceFileUploadChunkResponse extends FileExplorerUploadChunkData {
  workspaceId: string;
}

export interface WorkspaceFileUploadCompleteResponse extends FileExplorerUploadCompleteData {
  workspaceId: string;
}

export interface WorkspaceFileUploadCancelResponse extends FileExplorerUploadCancelData {
  success: true;
  workspaceId: string;
}

export interface ExecutionHostFileListResponse extends FileExplorerListData {
  serverId: string;
}

export interface ExecutionHostFileTreeResponse extends FileExplorerTreeData {
  serverId: string;
}

export interface ExecutionHostFileReadResponse extends FileExplorerReadData {
  serverId: string;
}

export interface ExecutionHostFileMetadataResponse extends FileExplorerMetadataData {
  serverId: string;
}

export interface ExecutionHostFileWriteResponse extends FileExplorerWriteData {
  serverId: string;
}

export interface ExecutionHostFileRenameResponse extends FileExplorerRenameData {
  serverId: string;
}

export interface ExecutionHostFileDeleteResponse extends FileExplorerDeleteData {
  serverId: string;
}

export interface ExecutionHostFileUploadCreateResponse extends FileExplorerUploadCreateData {
  serverId: string;
}

export interface ExecutionHostFileUploadChunkResponse extends FileExplorerUploadChunkData {
  serverId: string;
}

export interface ExecutionHostFileUploadCompleteResponse extends FileExplorerUploadCompleteData {
  serverId: string;
}

export interface ExecutionHostFileUploadCancelResponse extends FileExplorerUploadCancelData {
  success: true;
  serverId: string;
}

export interface FileExplorerConflictResponse {
  error: "file_conflict";
  message: string;
  currentFile: WorkspaceFileEntry | null;
}

export type WorkspaceFileConflictResponse = FileExplorerConflictResponse;

/**
 * Request body for POST /api/terminal-sessions.
 */
export type CreateTerminalSessionRequest = z.infer<typeof CreateTerminalSessionRequestSchema>;

/**
 * Request body for PATCH /api/terminal-sessions/:id.
 */
export type UpdateTerminalSessionRequest = z.infer<typeof UpdateTerminalSessionRequestSchema>;

/**
 * Request body for POST /api/execution-hosts/:kind/:id/prerequisites.
 */
export type CheckExecutionHostPrerequisitesRequest = z.infer<typeof CheckExecutionHostPrerequisitesRequestSchema>;

/**
 * Request body for POST /api/execution-hosts/:kind/:id/devbox-templates.
 */
export type GetDevboxTemplatesRequest = z.infer<typeof GetDevboxTemplatesRequestSchema>;

/**
 * Generic error response format used by all API endpoints.
 */
export interface ErrorResponse {
  /** Error code for programmatic handling (e.g., "not_found", "validation_error") */
  error: string;
  /** Human-readable error description */
  message: string;
}

/**
 * Response from GET /api/health endpoint.
 */
export interface HealthResponse {
  /** Always true when server is responding */
  healthy: boolean;
  /** Server version string */
  version: string;
}

/**
 * File diff information returned by GET /api/chats/:id/diff.
 */
export interface FileDiff {
  /** File path relative to repository root */
  path: string;
  /** Type of change made to the file */
  status: "added" | "modified" | "deleted" | "renamed";
  /** Number of lines added; null until an untracked file is opened */
  additions: number | null;
  /** Number of lines deleted; null until an untracked file is opened */
  deletions: number | null;
  /** Old path (only present for renames) */
  oldPath?: string;
}

/** Response from GET /api/chats/:id/diff/file. */
export interface FileDiffContent extends FileDiff {
  additions: number;
  deletions: number;
  patch: string;
}

/**
 * Response from GET /api/chats/:id/plan and /api/chats/:id/status-file.
 */
export interface FileContentResponse {
  /** The file contents (empty string if file doesn't exist) */
  content: string;
  /** Whether the file exists on disk */
  exists: boolean;
}

export type { ChatRepositoryContext } from "@/shared/chat";
