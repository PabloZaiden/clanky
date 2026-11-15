import { z } from "zod";

export const WorkspaceEnvironmentStatusSchema = z.object({
  id: z.string().uuid(),
  running: z.boolean(),
  remoteUser: z.string().nullable(),
  updateWarning: z.string().nullable(),
  containerId: z.string().nullable(),
});

export const RemoveWorkspaceEnvironmentRequestSchema = z.object({
  resetCredentials: z.boolean().default(false),
}).strict();

export const EnvironmentMutationResponseSchema = z.object({ success: z.literal(true) });

export type WorkspaceEnvironmentStatus = z.infer<typeof WorkspaceEnvironmentStatusSchema>;
export type RemoveWorkspaceEnvironmentRequest = z.infer<typeof RemoveWorkspaceEnvironmentRequestSchema>;
