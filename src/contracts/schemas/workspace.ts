/**
 * Zod schemas for workspace-related API requests.
 *
 * These schemas validate request bodies for workspace CRUD and
 * server settings operations.
 *
 * @module contracts/schemas/workspace
 */

import { z } from "zod";
import { AGENT_PROVIDER_IDS } from "@/shared";
import { ExecutionHostRefSchema } from "./execution-host";

/**
 * Agent provider options.
 */
export const AgentProviderSchema = z.enum(AGENT_PROVIDER_IDS);

export const WorkspaceTypeSchema = z.enum(["git", "directory"]);

/**
 * Agent transport options.
 * - stdio: local ACP CLI process
 * - ssh: ACP CLI process started over SSH
 */
export const AgentSettingsSchema = z.object({
  provider: AgentProviderSchema,
}).strict();

/**
 * Schema for workspace server settings.
 *
 * This schema is the single source of truth. The ServerSettings type is inferred from it.
 */
export const ServerSettingsSchema = z.object({
  agent: AgentSettingsSchema,
}).strict();

/**
 * Schema for CreateWorkspaceRequest - POST /api/workspaces
 *
 * serverSettings is optional - defaults to getDefaultServerSettings() if not provided.
 * The CreateWorkspaceRequest type in types/workspace.ts is derived from this schema.
 */
export const CreateWorkspaceRequestSchema = z.object({
  name: z.string().min(1, "name is required"),
  directory: z.string().min(1, "directory is required"),
  serverSettings: ServerSettingsSchema,
  executionHost: ExecutionHostRefSchema,
  allowClankyContext: z.boolean().optional(),
  workspaceType: WorkspaceTypeSchema.default("git"),
});

/**
 * Schema for UpdateWorkspaceRequest - PUT /api/workspaces/:id
 *
 * All fields are optional.
 * The UpdateWorkspaceRequest type in types/workspace.ts is derived from this schema.
 */
export const UpdateWorkspaceRequestSchema = z.object({
  name: z.string().optional(),
  serverSettings: ServerSettingsSchema.optional(),
  executionHost: ExecutionHostRefSchema.optional(),
  isPrivate: z.boolean().optional(),
  archived: z.boolean().optional(),
  allowClankyContext: z.boolean().optional(),
});

/**
 * Schema for DeleteWorkspaceRequest - DELETE /api/workspaces/:id
 */
export const DeleteWorkspaceRequestSchema = z.object({
  deleteServerDirectory: z.boolean().optional(),
  credentialToken: z.string().optional().nullable(),
});

/**
 * Schema for testing connection without a workspace - POST /api/server-settings/test
 */
export const TestConnectionRequestSchema = z.object({
  settings: ServerSettingsSchema,
  directory: z.string().min(1, "directory is required"),
  executionHost: ExecutionHostRefSchema,
});

// Export inferred types
/**
 * ServerSettings type - inferred from ServerSettingsSchema.
 * This is the single source of truth for server connection configuration.
 */
export type AgentProvider = z.infer<typeof AgentProviderSchema>;
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;
export type ServerSettings = z.infer<typeof ServerSettingsSchema>;

export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;
export type UpdateWorkspaceRequest = z.infer<typeof UpdateWorkspaceRequestSchema>;
export type DeleteWorkspaceRequest = z.infer<typeof DeleteWorkspaceRequestSchema>;
