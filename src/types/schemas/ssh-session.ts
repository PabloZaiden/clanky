/**
 * Zod schemas for SSH session API requests.
 */

import { z } from "zod";

export const SshConnectionModeSchema = z.enum(["dtach", "direct"]);

export const CreateSshSessionRequestSchema = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
  name: z.string().trim().min(1, "name is required"),
  connectionMode: SshConnectionModeSchema,
});

export const UpdateSshSessionRequestSchema = z.object({
  name: z.string().trim().min(1, "name is required"),
});

export const CreatePortForwardRequestSchema = z.object({
  remotePort: z.number().int().min(1).max(65535),
});
