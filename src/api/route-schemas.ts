import { z } from "zod";
import { RepositoryNameSchema } from "@/contracts/schemas/repository-group";

export const SensitiveQuerySchema = z.object({
  sensitive: z.enum(["true", "false"]).optional(),
});

export const WorkspaceFilterQuerySchema = z.object({
  workspaceId: z.string().min(1).max(128).optional(),
}).strict();

export const WorkspaceQuerySchema = WorkspaceFilterQuerySchema.required();
export const RepositoryQuerySchema = z.object({ repository: RepositoryNameSchema.optional() }).strict();
export const WorkspaceGitQuerySchema = WorkspaceQuerySchema.extend(RepositoryQuerySchema.shape);

export const ModelVariantsQuerySchema = WorkspaceQuerySchema.extend({
  modelID: z.string().min(1).max(512),
}).strict();

export const GitRemoteStatusQuerySchema = WorkspaceGitQuerySchema.extend({
  remote: z.string().trim().max(512).optional(),
}).strict();

export const TranscriptSnapshotQuerySchema = z.object({
  before: z.string().min(1).max(2048).optional(),
  since: z.string().min(1).max(2048).optional(),
  full: z.literal("1").optional(),
}).strict();

export const TranscriptDownloadQuerySchema = z.object({
  download: z.literal("1").optional(),
}).strict();
