/**
 * Zod schemas for settings maintenance actions.
 */

import { z } from "zod";
import { SshCredentialTokenSchema } from "./ssh-server";

const RequiredTrimmedStringSchema = z.string().trim().min(1, "value is required");

export const RestartAutomaticWorkspacesRequestSchema = z.object({
  credentialTokensByServerId: z.record(
    RequiredTrimmedStringSchema,
    SshCredentialTokenSchema,
  ).default({}),
  credentialUnavailableServerIds: z.array(RequiredTrimmedStringSchema).default([]),
});

export const RestartAutomaticWorkspacesResultSchema = z.object({
  totalWorkspaces: z.number().int().nonnegative(),
  started: z.array(z.object({
    workspaceId: RequiredTrimmedStringSchema,
    workspaceName: z.string(),
    provisioningJobId: RequiredTrimmedStringSchema,
  })),
  failures: z.array(z.object({
    workspaceId: RequiredTrimmedStringSchema,
    workspaceName: z.string(),
    error: RequiredTrimmedStringSchema,
  })),
});

export const RestartAutomaticWorkspacesResponseSchema =
  RestartAutomaticWorkspacesResultSchema.extend({
    success: z.literal(true),
  });
