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

import type { AgentProvider, ServerSettings } from "./settings";

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
  /** Whether activity from this workspace should be hidden from active-work surfaces */
  archived?: boolean;
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
