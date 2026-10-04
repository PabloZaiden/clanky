/**
 * Zod schemas for workspace-related API requests.
 *
 * These schemas validate request bodies for workspace CRUD and
 * server settings operations.
 *
 * @module contracts/schemas/workspace
 */

import { z } from "zod";
import { AGENT_PROVIDER_IDS, HARNESS_ADAPTER_IDS, isAgentSettings } from "@/shared";
import { ExecutionHostRefSchema } from "./execution-host";

/**
 * Agent provider options.
 */
export const AgentProviderSchema = z.enum(AGENT_PROVIDER_IDS);

export const WorkspaceTypeSchema = z.enum(["git", "directory"]);

/**
 * Adapter selection is independent of the execution host. ACP selects a preset.
 */
export const AgentSettingsSchema = z.object({
  adapter: z.enum(HARNESS_ADAPTER_IDS),
  provider: AgentProviderSchema,
}).strict().refine(isAgentSettings, { message: "The harness preset does not match the native adapter", path: ["provider"] });

/**
 * Schema for workspace server settings.
 *
 * This schema is the single source of truth. The ServerSettings type is inferred from it.
 */
export const ServerSettingsSchema = z.object({
  agent: AgentSettingsSchema,
}).strict();

export const WorkspaceSshTargetSchema = z.object({
  host: z.string().min(1, "host is required"),
  port: z.number().int().min(1).max(65535),
  username: z.string().min(1, "username is required"),
  password: z.string().nullable().optional(),
}).strict();

/**
 * Schema for CreateWorkspaceRequest - POST /api/workspaces
 *
 * serverSettings selects the adapter/preset independently of the execution host.
 * The CreateWorkspaceRequest type in types/workspace.ts is derived from this schema.
 */
export const CreateWorkspaceRequestSchema = z.object({
  name: z.string().min(1, "name is required"),
  directory: z.string().min(1, "directory is required"),
  serverSettings: ServerSettingsSchema,
  executionHost: ExecutionHostRefSchema.optional(),
  sshTarget: WorkspaceSshTargetSchema.optional(),
  workspaceWorkerEnrollmentId: z.string().trim().min(1).optional(),
  allowClankyContext: z.boolean().optional(),
  allowWorktrees: z.boolean().optional(),
  workspaceType: WorkspaceTypeSchema.default("git"),
}).refine(
  (value) => [
    Boolean(value.executionHost),
    Boolean(value.sshTarget),
    Boolean(value.workspaceWorkerEnrollmentId),
  ].filter(Boolean).length === 1,
  {
    message: "Exactly one execution host, SSH target, or dedicated worker enrollment is required",
    path: ["executionHost"],
  },
);

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
  sshTarget: WorkspaceSshTargetSchema.nullable().optional(),
  isPrivate: z.boolean().optional(),
  archived: z.boolean().optional(),
  allowClankyContext: z.boolean().optional(),
  allowWorktrees: z.boolean().optional(),
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
  executionHost: ExecutionHostRefSchema.optional(),
  sshTarget: WorkspaceSshTargetSchema.optional(),
  workspaceWorkerEnrollmentId: z.string().trim().min(1).optional(),
}).refine(
  (value) => [
    Boolean(value.executionHost),
    Boolean(value.sshTarget),
    Boolean(value.workspaceWorkerEnrollmentId),
  ].filter(Boolean).length === 1,
  {
    message: "Exactly one execution host, SSH target, or dedicated worker enrollment is required",
    path: ["executionHost"],
  },
);

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
export type WorkspaceSshTargetRequest = z.infer<typeof WorkspaceSshTargetSchema>;
