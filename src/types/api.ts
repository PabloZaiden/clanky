/**
 * API type definitions for Ralph Loops Management System.
 * 
 * These types define the request and response shapes for the REST API.
 * They are used for type safety in both the API route handlers and clients.
 * 
 * Request types for validated endpoints are derived from Zod schemas,
 * making the schemas the single source of truth for both runtime validation
 * and TypeScript types.
 * 
 * @module types/api
 */

import type { ReviewComment } from "./loop";
import type { SshServer } from "./ssh-server";
import type { SshSession } from "./ssh-session";
import {
  CreateLoopRequestSchema,
  GenerateLoopTitleRequestSchema,
  UpdateLoopRequestSchema,
  AddressCommentsRequestSchema,
  SendChatMessageRequestSchema,
  CreateChatRequestSchema,
  CreateSshSessionRequestSchema,
  UpdateSshSessionRequestSchema,
  PlanAcceptRequestSchema,
  CreateSshServerRequestSchema,
  UpdateSshServerRequestSchema,
  CreateSshServerSessionRequestSchema,
  SshCredentialExchangeRequestSchema,
  DeleteSshServerSessionRequestSchema,
} from "./schemas";
import type { z } from "zod";

/**
 * Response from GET /api/config.
 */
export interface AppConfig {
  /** Whether remote-only mode is enabled */
  remoteOnly: boolean;
  /** Public base path inferred from reverse-proxy headers, if any */
  publicBasePath?: string;
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
 * Request body for POST /api/loops endpoint.
 * 
 * Creates a new Ralph Loop. Loops are started immediately after creation
 * unless `draft: true` is specified, which saves the loop for later editing.
 * 
 * If `planMode: true`, the loop starts in plan review mode before execution.
 * 
 * The loop name is required and must be provided by the client.
 * 
 * The `workspaceId` is required - loops must be created within a workspace.
 * The directory is automatically derived from the workspace.
 * 
 * Type is derived from CreateLoopRequestSchema - the Zod schema is the
 * single source of truth for both validation and TypeScript types.
 */
export type CreateLoopRequest = z.infer<typeof CreateLoopRequestSchema>;

/**
 * Request body for POST /api/loops/title endpoint.
 *
 * Requests explicit AI-assisted title generation for the current prompt
 * using the selected workspace context.
 */
export type GenerateLoopTitleRequest = z.infer<typeof GenerateLoopTitleRequestSchema>;

/**
 * Response from POST /api/loops/title endpoint.
 */
export interface GenerateLoopTitleResponse {
  title: string;
}

/**
 * Request body for POST /api/ssh-sessions.
 */
export type CreateSshSessionRequest = z.infer<typeof CreateSshSessionRequestSchema>;

/**
 * Request body for PATCH /api/loops/:id endpoint.
 * All fields are optional - only provided fields are updated.
 * 
 * Type is derived from UpdateLoopRequestSchema - the Zod schema is the
 * single source of truth for both validation and TypeScript types.
 */
export type UpdateLoopRequest = z.infer<typeof UpdateLoopRequestSchema>;

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
 * Response from GET /api/ssh-servers.
 */
export type ListSshServersResponse = SshServer[];

/**
 * Request body for POST /api/loops/:id/address-comments endpoint.
 * Used to submit reviewer comments for the loop to address.
 * 
 * Type is derived from AddressCommentsRequestSchema - the Zod schema is the
 * single source of truth for both validation and TypeScript types.
 */
export type AddressCommentsRequest = z.infer<typeof AddressCommentsRequestSchema>;

/**
 * Request body for POST /api/loops/:id/plan/accept endpoint.
 */
export type PlanAcceptRequest = z.infer<typeof PlanAcceptRequestSchema>;

/**
 * Response from POST /api/loops/:id/address-comments endpoint.
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
 * Response from GET /api/loops/:id/comments endpoint.
 * Uses discriminated union for type-safe success/error handling.
 */
export type GetCommentsResponse =
  | {
      success: true;
      /** Array of review comments for the loop */
      comments: ReviewComment[];
    }
  | {
      success: false;
      /** Error message describing what went wrong */
      error: string;
    };

/**
 * Review history information for a loop.
 * Returned by GET /api/loops/:id/review-history endpoint.
 */
export interface ReviewHistory {
  /** Whether the loop can still receive reviewer comments */
  addressable: boolean;
  /** How the loop was originally completed (push or merge) */
  completionAction: "push" | "merge";
  /** Number of review cycles completed (times comments were addressed) */
  reviewCycles: number;
  /** For merged loops: list of all branches created during review cycles */
  reviewBranches: string[];
}

/**
 * Response from GET /api/loops/:id/review-history endpoint.
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
 * Response from POST /api/loops/:id/accept endpoint.
 * Uses discriminated union for type-safe success/error handling.
 */
export type AcceptResponse =
  | {
      success: true;
      /** The SHA of the merge commit created */
      mergeCommit: string;
    }
  | {
      success: false;
      /** Error message describing what went wrong */
      error: string;
    };

/**
 * Response from POST /api/loops/:id/push endpoint.
 * Uses discriminated union for type-safe success/error handling.
 *
 * When syncStatus is "conflicts_being_resolved", the push is deferred
 * (no remoteBranch yet). The loop will auto-push after conflict resolution.
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
 * Response from POST /api/loops/:id/plan/accept endpoint.
 */
export type PlanAcceptResponse =
  | {
      success: true;
      /** Which acceptance path was taken */
      mode: "start_loop";
    }
  | {
      success: true;
      /** Which acceptance path was taken */
      mode: "open_ssh";
      /** Linked SSH session created or reused for the loop */
      sshSession: SshSession;
    };

/**
 * Error response returned when directory has uncommitted changes.
 * 
 * This error (HTTP 409) indicates the loop cannot start because the
 * working directory has uncommitted git changes. The user must commit
 * or stash changes manually before starting the loop.
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
 * File diff information returned by GET /api/loops/:id/diff endpoint.
 * Represents changes to a single file in the loop's working branch.
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
 * Response from GET /api/loops/:id/plan and /api/loops/:id/status-file endpoints.
 */
export interface FileContentResponse {
  /** The file contents (empty string if file doesn't exist) */
  content: string;
  /** Whether the file exists on disk */
  exists: boolean;
}

/**
 * Response from GET /api/loops/:id/pull-request endpoint.
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

/**
 * Request body for POST /api/loops/:id/chat endpoint.
 * Sends a message to an interactive chat.
 *
 * Type is derived from SendChatMessageRequestSchema - the Zod schema is the
 * single source of truth for both validation and TypeScript types.
 */
export type SendChatMessageRequest = z.infer<typeof SendChatMessageRequestSchema>;

/**
 * Request body for POST /api/loops/chat endpoint.
 * Creates a new interactive chat.
 *
 * Simpler than CreateLoopRequest — chats don't have plan mode,
 * draft mode, stop patterns, or clearPlanningFolder.
 *
 * Type is derived from CreateChatRequestSchema - the Zod schema is the
 * single source of truth for both validation and TypeScript types.
 */
export type CreateChatRequest = z.infer<typeof CreateChatRequestSchema>;

/**
 * Response from POST /api/loops/:id/chat endpoint.
 * Returns after the backend has safely accepted the message and coordinated
 * any required chat-turn restart. It does not wait for the AI response to
 * finish streaming.
 * Uses discriminated union for type-safe success/error handling.
 */
export type SendChatMessageResponse =
  | {
      success: true;
      /** The loop/chat ID that received the message */
      loopId: string;
    }
  | {
      success: false;
      /** Error message describing what went wrong */
      error: string;
    };
