/**
 * API type definitions for Clanky Tasks Management System.
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
  ReviewComment,
  SshServer,
  SshSession,
  WorkspaceFileEntry,
  WorkspaceFileKind,
  WorkspaceFileNode,
} from "@/shared";
import {
  CreateTaskRequestSchema,
  CreateChatRequestSchema,
  CreateSshServerChatRequestSchema,
  DiscoverSshServerChatModelsRequestSchema,
  DiscoverSshServerChatProvidersRequestSchema,
  GenerateTaskTitleRequestSchema,
  InterruptChatRequestSchema,
  ReplyToChatPermissionRequestSchema,
  ReconnectChatRequestSchema,
  SendChatMessageRequestSchema,
  SpawnCurrentPlanTaskRequestSchema,
  UpdateTaskRequestSchema,
  UpdateChatRequestSchema,
  ImportExistingChatRequestSchema,
  AddressCommentsRequestSchema,
  CreateSshSessionRequestSchema,
  UpdateSshSessionRequestSchema,
  PlanAcceptRequestSchema,
  CreateSshServerRequestSchema,
  UpdateSshServerRequestSchema,
  CreateSshServerSessionRequestSchema,
  SshCredentialExchangeRequestSchema,
  DeleteSshServerSessionRequestSchema,
  CheckSshServerPrerequisitesRequestSchema,
  GetDevboxTemplatesRequestSchema,
  CreateWorkspaceRequestSchema,
  UpdateWorkspaceRequestSchema,
  DeleteWorkspaceRequestSchema,
  CreateProvisioningJobRequestSchema,
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
} from "./schemas";
import type { z } from "zod";

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
  /** Branch name (e.g., "main", "feature/auth") */
  name: string;
  /** Whether this is the currently checked out branch */
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
  /** Whether the provider is connected (has valid API key configured) */
  connected: boolean;
  /**
   * Available variants for this model.
   * Each variant name is a key from the SDK's model.variants object.
   * An empty string ("") represents the default/no-variant option.
   * If undefined or empty, the model has no variants.
   */
  variants?: string[];
}

/**
 * Request body for POST /api/tasks endpoint.
 * 
 * Creates a new Clanky Task. Tasks are started immediately after creation
 * unless `draft: true` is specified, which saves the task for later editing.
 * 
 * If `planMode: true`, the task starts in plan review mode before execution.
 * 
 * The task name is required and must be provided by the client.
 * 
 * The `workspaceId` is required - tasks must be created within a workspace.
 * The directory is automatically derived from the workspace.
 * 
 * Type is derived from CreateTaskRequestSchema - the Zod schema is the
 * single source of truth for both validation and TypeScript types.
 */
export type CreateTaskRequest = z.infer<typeof CreateTaskRequestSchema>;
export type CreateChatRequest = z.infer<typeof CreateChatRequestSchema>;
export type CreateSshServerChatRequest = z.infer<typeof CreateSshServerChatRequestSchema>;
export type ImportExistingChatRequest = z.infer<typeof ImportExistingChatRequestSchema>;

/**
 * Request body for POST /api/tasks/title endpoint.
 *
 * Requests explicit AI-assisted title generation for the current prompt
 * using the selected workspace and model context.
 */
export type GenerateTaskTitleRequest = z.infer<typeof GenerateTaskTitleRequestSchema>;

/**
 * Response from POST /api/tasks/title endpoint.
 */
export interface GenerateTaskTitleResponse {
  title: string;
}

/**
 * Request body for POST /api/ssh-sessions.
 */
export type CreateSshSessionRequest = z.infer<typeof CreateSshSessionRequestSchema>;

/**
 * Request body for PATCH /api/tasks/:id endpoint.
 * All fields are optional - only provided fields are updated. Name updates
 * are accepted only while the task is still a draft.
 * 
 * Type is derived from UpdateTaskRequestSchema - the Zod schema is the
 * single source of truth for both validation and TypeScript types.
 */
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequestSchema>;
export type UpdateChatRequest = z.infer<typeof UpdateChatRequestSchema>;
export type SendChatMessageRequest = z.infer<typeof SendChatMessageRequestSchema>;
export type InterruptChatRequest = z.infer<typeof InterruptChatRequestSchema>;
export type ReplyToChatPermissionRequest = z.infer<typeof ReplyToChatPermissionRequestSchema>;
export type ReconnectChatRequest = z.infer<typeof ReconnectChatRequestSchema>;
export type DiscoverSshServerChatProvidersRequest = z.infer<typeof DiscoverSshServerChatProvidersRequestSchema>;
export type DiscoverSshServerChatModelsRequest = z.infer<typeof DiscoverSshServerChatModelsRequestSchema>;
export type SpawnCurrentPlanTaskRequest = z.infer<typeof SpawnCurrentPlanTaskRequestSchema>;
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequestSchema>;
export type DeleteWorkspaceRequest = z.infer<typeof DeleteWorkspaceRequestSchema>;
export type CreateProvisioningJobRequest = z.infer<typeof CreateProvisioningJobRequestSchema>;

export type ListChatsResponse = Chat[];

export type ListWorkspaceFilesRequest = z.input<typeof ListFileExplorerRequestSchema>;
export type GetWorkspaceFileTreeRequest = z.input<typeof GetFileExplorerTreeRequestSchema>;
export type GetWorkspaceFileRequest = z.input<typeof GetFileExplorerFileRequestSchema>;
export type WriteWorkspaceFileRequest = z.input<typeof WriteFileExplorerRequestSchema>;
export type RenameWorkspaceFileRequest = z.input<typeof RenameFileExplorerRequestSchema>;
export type DeleteWorkspaceFileRequest = z.input<typeof DeleteFileExplorerRequestSchema>;
export type CreateWorkspaceFileUploadRequest = z.input<typeof CreateFileExplorerUploadRequestSchema>;
export type UploadWorkspaceFileChunkRequest = z.input<typeof UploadFileExplorerChunkRequestSchema>;
export type CompleteWorkspaceFileUploadRequest = z.input<typeof CompleteFileExplorerUploadRequestSchema>;
export type CancelWorkspaceFileUploadRequest = z.input<typeof CancelFileExplorerUploadRequestSchema>;

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

export interface SshServerFileListResponse extends FileExplorerListData {
  serverId: string;
}

export interface SshServerFileTreeResponse extends FileExplorerTreeData {
  serverId: string;
}

export interface SshServerFileReadResponse extends FileExplorerReadData {
  serverId: string;
}

export interface SshServerFileMetadataResponse extends FileExplorerMetadataData {
  serverId: string;
}

export interface SshServerFileWriteResponse extends FileExplorerWriteData {
  serverId: string;
}

export interface SshServerFileRenameResponse extends FileExplorerRenameData {
  serverId: string;
}

export interface SshServerFileDeleteResponse extends FileExplorerDeleteData {
  serverId: string;
}

export interface SshServerFileUploadCreateResponse extends FileExplorerUploadCreateData {
  serverId: string;
}

export interface SshServerFileUploadChunkResponse extends FileExplorerUploadChunkData {
  serverId: string;
}

export interface SshServerFileUploadCompleteResponse extends FileExplorerUploadCompleteData {
  serverId: string;
}

export interface SshServerFileUploadCancelResponse extends FileExplorerUploadCancelData {
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
 * Request body for PATCH /api/ssh-sessions/:id.
 */
export type UpdateSshSessionRequest = z.infer<typeof UpdateSshSessionRequestSchema>;

/**
 * Request body for POST /api/ssh-servers.
 */
export type CreateSshServerRequest = z.infer<typeof CreateSshServerRequestSchema>;

/**
 * Request body for PATCH /api/ssh-servers/:id.
 */
export type UpdateSshServerRequest = z.infer<typeof UpdateSshServerRequestSchema>;

/**
 * Request body for POST /api/ssh-servers/:id/sessions.
 */
export type CreateSshServerSessionRequest = z.infer<typeof CreateSshServerSessionRequestSchema>;

/**
 * Request body for POST /api/ssh-servers/:id/credentials.
 */
export type SshCredentialExchangeRequest = z.infer<typeof SshCredentialExchangeRequestSchema>;

/**
 * Request body for DELETE /api/ssh-server-sessions/:id.
 */
export type DeleteSshServerSessionRequest = z.infer<typeof DeleteSshServerSessionRequestSchema>;

/**
 * Request body for POST /api/ssh-servers/:id/prerequisites/check.
 */
export type CheckSshServerPrerequisitesRequest = z.infer<typeof CheckSshServerPrerequisitesRequestSchema>;

/**
 * Request body for POST /api/ssh-servers/:id/devbox/templates.
 */
export type GetDevboxTemplatesRequest = z.infer<typeof GetDevboxTemplatesRequestSchema>;

/**
 * Response from GET /api/ssh-servers.
 */
export type ListSshServersResponse = SshServer[];

/**
 * Request body for POST /api/tasks/:id/address-comments endpoint.
 * Used to submit reviewer comments for the task to address.
 * 
 * Type is derived from AddressCommentsRequestSchema - the Zod schema is the
 * single source of truth for both validation and TypeScript types.
 */
export type AddressCommentsRequest = z.infer<typeof AddressCommentsRequestSchema>;

/**
 * Request body for POST /api/tasks/:id/plan/accept endpoint.
 */
export type PlanAcceptRequest = z.infer<typeof PlanAcceptRequestSchema>;

/**
 * Response from POST /api/tasks/:id/address-comments endpoint.
 * Uses discriminated union for type-safe success/error handling.
 */
export type AddressCommentsResponse =
  | {
      success: true;
      /** The review cycle number (1-based, increments each time comments are addressed) */
      reviewCycle: number;
      /** The branch being worked on */
      branch: string;
      /** IDs of the comment records created */
      commentIds: string[];
    }
  | {
      success: false;
      /** Error message describing what went wrong */
      error: string;
    };

/**
 * Response from GET /api/tasks/:id/comments endpoint.
 * Uses discriminated union for type-safe success/error handling.
 */
export type GetCommentsResponse =
  | {
      success: true;
      /** Array of review comments for the task */
      comments: ReviewComment[];
    }
  | {
      success: false;
      /** Error message describing what went wrong */
      error: string;
    };

/**
 * Review history information for a task.
 * Returned by GET /api/tasks/:id/review-history endpoint.
 */
export interface ReviewHistory {
  /** Whether the task can still receive reviewer comments */
  addressable: boolean;
  /** How the task was last finalized */
  completionAction: "local" | "push";
  /** Number of review cycles completed (times comments were addressed) */
  reviewCycles: number;
}

/**
 * Response from GET /api/tasks/:id/review-history endpoint.
 * Uses discriminated union for type-safe success/error handling.
 */
export type ReviewHistoryResponse =
  | {
      success: true;
      /** The review history data */
      history: ReviewHistory;
    }
  | {
      success: false;
      /** Error message describing what went wrong */
      error: string;
    };

/**
 * Response from POST /api/tasks/:id/accept endpoint.
 * Uses discriminated union for type-safe success/error handling.
 */
export type AcceptResponse =
  | {
      success: true;
    }
  | {
      success: false;
      /** Error message describing what went wrong */
      error: string;
    };

/**
 * Response from POST /api/tasks/:id/push endpoint.
 * Uses discriminated union for type-safe success/error handling.
 *
 * When syncStatus is "conflicts_being_resolved", the push is deferred
 * (no remoteBranch yet). The task will auto-push after conflict resolution.
 */
export type PushResponse =
  | {
      success: true;
      /** The name of the remote branch that was pushed */
      remoteBranch: string;
      /** Sync status with base branch */
      syncStatus: "already_up_to_date" | "clean";
    }
  | {
      success: true;
      /** Sync status — push is deferred until conflict resolution completes */
      syncStatus: "conflicts_being_resolved";
    }
  | {
      success: false;
      /** Error message describing what went wrong */
      error: string;
    };

/**
 * Response from POST /api/tasks/:id/plan/accept endpoint.
 */
export type PlanAcceptResponse =
  | {
      success: true;
      /** Which acceptance path was taken */
      mode: "start_task";
    }
  | {
      success: true;
      /** Which acceptance path was taken */
      mode: "open_ssh";
      /** Linked SSH session created or reused for the task */
      sshSession: SshSession;
    };

/**
 * Error response returned when directory has uncommitted changes.
 * 
 * This error (HTTP 409) indicates the task cannot start because the
 * working directory has uncommitted git changes. The user must commit
 * or stash changes manually before starting the task.
 */
export interface UncommittedChangesError {
  /** Error code for this specific error type */
  error: "uncommitted_changes";
  /** Human-readable error description */
  message: string;
  /** List of files with uncommitted changes */
  changedFiles: string[];
}

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
 * File diff information returned by GET /api/tasks/:id/diff endpoint.
 * Represents changes to a single file in the task's working branch.
 */
export interface FileDiff {
  /** File path relative to repository root */
  path: string;
  /** Type of change made to the file */
  status: "added" | "modified" | "deleted" | "renamed";
  /** Number of lines added */
  additions: number;
  /** Number of lines deleted */
  deletions: number;
  /** Old path (only present for renames) */
  oldPath?: string;
  /** The actual diff patch content in unified diff format */
  patch?: string;
}

/**
 * Response from GET /api/tasks/:id/plan and /api/tasks/:id/status-file endpoints.
 */
export interface FileContentResponse {
  /** The file contents (empty string if file doesn't exist) */
  content: string;
  /** Whether the file exists on disk */
  exists: boolean;
}

/**
 * Response from GET /api/tasks/:id/pull-request endpoint.
 */
export type PullRequestDestinationResponse =
  | {
      enabled: true;
      /** Where the destination came from */
      destinationType: "existing_pr" | "create_pr";
      /** URL to open when the action is available */
      url: string;
    }
  | {
      enabled: false;
      /** Disabled state for the Go to PR action */
      destinationType: "disabled";
      /** Human-readable reason shown in the UI */
      disabledReason: string;
    };
