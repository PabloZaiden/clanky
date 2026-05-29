/**
 * Zod schemas for workspace-related API requests.
 *
 * These schemas validate request bodies for workspace CRUD and
 * server settings operations.
 *
 * @module types/schemas/workspace
 */

import { z } from "zod";

/**
 * Agent provider options.
 */
export const AgentProviderSchema = z.enum(["opencode", "copilot", "codex"]);

/**
 * Agent transport options.
 * - stdio: local ACP CLI process
 * - ssh: ACP CLI process started over SSH
 */
export const AgentTransportSchema = z.enum(["stdio", "ssh"]);

const StdioAgentSettingsSchema = z.object({
  provider: AgentProviderSchema,
  transport: z.literal("stdio"),
});

const SshAgentSettingsSchema = z.object({
  provider: AgentProviderSchema,
  transport: z.literal("ssh"),
  hostname: z.string().min(1, "hostname is required for ssh transport"),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  identityFile: z.string().min(1).optional(),
});

/**
 * Schema for the agent settings.
 *
 * Note: this is intentionally a single channel config. Execution behavior is
 * derived from transport:
 * - stdio => local deterministic execution
 * - ssh => ssh deterministic execution
 */
export const AgentSettingsSchema = z.discriminatedUnion("transport", [
  StdioAgentSettingsSchema,
  SshAgentSettingsSchema,
]);

/**
 * Schema for workspace server settings.
 *
 * This schema is the single source of truth. The ServerSettings type is inferred from it.
 */
export const ServerSettingsSchema = z.object({
  agent: AgentSettingsSchema,
});

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
});

/**
 * Schema for a single workspace config in an export file.
 * Contains only the portable configuration fields (no id/timestamps).
 */
export const WorkspaceConfigSchema = z.object({
  name: z.string().min(1, "name is required"),
  directory: z.string().min(1, "directory is required"),
  serverSettings: ServerSettingsSchema,
});

/**
 * Schema for the workspace export envelope.
 * Contains version info and an array of workspace configs.
 */
export const WorkspaceExportSchema = z.object({
  version: z.literal(1),
  exportedAt: z.string(),
  workspaces: z.array(WorkspaceConfigSchema),
});

/**
 * Schema for the import request body - same as the export envelope.
 */
export const WorkspaceImportRequestSchema = WorkspaceExportSchema;

// Export inferred types
/**
 * ServerSettings type - inferred from ServerSettingsSchema.
 * This is the single source of truth for server connection configuration.
 */
export type AgentProvider = z.infer<typeof AgentProviderSchema>;
export type AgentTransport = z.infer<typeof AgentTransportSchema>;
export type AgentSettings = z.infer<typeof AgentSettingsSchema>;
export type ServerSettings = z.infer<typeof ServerSettingsSchema>;

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;
export type WorkspaceExportData = z.infer<typeof WorkspaceExportSchema>;
export type WorkspaceImportRequest = z.infer<typeof WorkspaceImportRequestSchema>;
export type DeleteWorkspaceRequest = z.infer<typeof DeleteWorkspaceRequestSchema>;
