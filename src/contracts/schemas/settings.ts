/**
 * Zod schemas for settings maintenance actions.
 */

import { z } from "zod";

const RequiredTrimmedStringSchema = z.string().trim().min(1, "value is required");

export const RestartAutomaticWorkspacesRequestSchema = z.object({}).strict();

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
