/**
 * Workspace type definitions for Clanky Tasks Management System.
 * 
 * Workspaces are identified by UUID and provide the execution context for
 * Clanky Tasks. Their directory is the location where workspace operations run.
 * 
 * Request types for validated endpoints are derived from Zod schemas,
 * making the schemas the single source of truth for both runtime validation
 * and TypeScript types.
 * 
 * @module types/workspace
 */

import type { ServerSettings } from "./settings";
import type { ExecutionHostBinding } from "./execution-host";

/**
 * A workspace represents a user-selected execution context for Clanky Tasks.
 *
 * Workspaces are selected by ID; the directory is an execution location and
 * does not identify the workspace.
 * Each workspace has its own server settings for independent operation.
 */
export interface Workspace {
  /** Unique identifier (UUID v4) */
  id: string;
  /** Human-readable workspace name */
  name: string;
  /** Absolute path to the workspace directory */
  directory: string;
  /** Whether the workspace exposes Git-backed task and branch capabilities */
  workspaceType: WorkspaceType;
  /** Monotonic revision of the workspace execution target */
  executionTargetRevision: number;
  /** Canonical immutable execution-host binding. */
  executionHostBinding: ExecutionHostBinding;
  /** Server connection settings for this workspace */
  serverSettings: ServerSettings;
  /** ISO 8601 timestamp of when the workspace was created */
  createdAt: string;
  /** ISO 8601 timestamp of the last update */
  updatedAt: string;
  /** Whether the item should be visually hidden when private items are hidden in the browser */
  isPrivate?: boolean;
  /** Whether activity from this workspace should be hidden from active-work surfaces */
  archived?: boolean;
  /** Whether new execution contexts may receive authenticated Clanky CLI access */
  allowClankyContext?: boolean;
  /** Directory on the remote host where the repo was cloned (for auto-provisioned workspaces) */
  sourceDirectory?: string;
  /** Git repository URL used during provisioning */
  repoUrl?: string;
  /** Base path on the remote host used during provisioning */
  basePath?: string;
  /** Optional devcontainer definition subpath used during provisioning */
  devcontainerSubpath?: string;
}

export type WorkspaceType = "git" | "directory";

export const DEFAULT_WORKSPACE_TYPE: WorkspaceType = "git";

export interface PublicServerSettings {
  agent: ServerSettings["agent"];
}

export interface PublicWorkspace extends Omit<Workspace, "serverSettings"> {
  serverSettings: PublicServerSettings;
}
