/**
 * Workspace type definitions for Clanky Tasks Management System.
 * 
 * Workspaces represent directories that contain Clanky Tasks.
 * Each workspace has a unique directory path and can contain multiple tasks.
 * 
 * Request types for validated endpoints are derived from Zod schemas,
 * making the schemas the single source of truth for both runtime validation
 * and TypeScript types.
 * 
 * @module types/workspace
 */

import type { AgentProvider, ServerSettings } from "./settings";
import {
  CreateWorkspaceRequestSchema,
  UpdateWorkspaceRequestSchema,
} from "./schemas";
import type { z } from "zod";

// Re-export schema-derived types for convenience
export type { WorkspaceConfig, WorkspaceExportData, WorkspaceImportRequest } from "./schemas";
export type { DeleteWorkspaceRequest } from "./schemas";

/**
 * A workspace represents a directory that contains Clanky Tasks.
 * 
 * Workspaces provide a way to group tasks by directory and allow
 * for simplified task creation via workspace selection.
 * Each workspace has its own server settings for independent operation.
 */
export interface Workspace {
  /** Unique identifier (UUID v4) */
  id: string;
  /** Human-readable workspace name */
  name: string;
  /** Absolute path to the directory (must be a git repository) */
  directory: string;
  /** Server connection settings for this workspace */
  serverSettings: ServerSettings;
  /** ISO 8601 timestamp of when the workspace was created */
  createdAt: string;
  /** ISO 8601 timestamp of the last update */
  updatedAt: string;
  /** Whether the item should be visually hidden when private items are hidden in the browser */
  isPrivate?: boolean;
  /** Directory on the remote host where the repo was cloned (for auto-provisioned workspaces) */
  sourceDirectory?: string;
  /** ID of the SSH server used for provisioning */
  sshServerId?: string;
  /** Git repository URL used during provisioning */
  repoUrl?: string;
  /** Base path on the remote host used during provisioning */
  basePath?: string;
  /** Optional devcontainer definition subpath used during provisioning */
  devcontainerSubpath?: string;
  /** Agent provider used during provisioning */
  provider?: AgentProvider;
}

export type PublicAgentSettings =
  | Extract<ServerSettings["agent"], { transport: "stdio" }>
  | Omit<Extract<ServerSettings["agent"], { transport: "ssh" }>, "password" | "identityFile">;

export interface PublicServerSettings {
  agent: PublicAgentSettings;
}

export interface PublicWorkspace extends Omit<Workspace, "serverSettings"> {
  serverSettings: PublicServerSettings;
}

export interface PublicWorkspaceConfig {
  name: string;
  directory: string;
  serverSettings: PublicServerSettings;
}

export interface PublicWorkspaceExportData {
  version: 1;
  exportedAt: string;
  workspaces: PublicWorkspaceConfig[];
}

/**
 * Request to create a new workspace.
 * 
 * serverSettings is optional - defaults are applied if not provided.
 * 
 * Type is derived from CreateWorkspaceRequestSchema - the Zod schema is the
 * single source of truth for both validation and TypeScript types.
 */
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

/**
 * Request to update an existing workspace.
 * All fields are optional - only provided fields are updated.
 * 
 * Type is derived from UpdateWorkspaceRequestSchema - the Zod schema is the
 * single source of truth for both validation and TypeScript types.
 */
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequestSchema>;

/**
 * Result of a workspace import operation.
 * Reports what was created, skipped, and failed.
 */
export interface WorkspaceImportResult {
  /** Number of workspaces successfully created */
  created: number;
  /** Number of workspaces skipped (directory already exists) */
  skipped: number;
  /** Number of workspaces that failed validation */
  failed: number;
  /** Details of each workspace in the import */
  details: Array<{
    /** Workspace name from the import file */
    name: string;
    /** Workspace directory from the import file */
    directory: string;
    /** Whether this workspace was created, skipped, or failed validation */
    status: "created" | "skipped" | "failed";
    /** Reason for skipping or failure */
    reason?: string;
  }>;
}
