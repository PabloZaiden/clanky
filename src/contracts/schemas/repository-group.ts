import { z } from "zod";

export const RepositoryNameSchema = z.string().min(1).max(255).refine(
  (value) => value !== "." && value !== ".." && !/[\/\0\r\n]/.test(value),
  "Choose a direct repository directory.",
);

const BaseRefSchema = z.string().max(1024).regex(
  /^refs\/(?:heads|remotes)\/[^\s\x00-\x1f\x7f]+$/,
  "Choose a local or remote-tracking branch.",
);
const IdentitySchema = z.string().min(1).max(256);
const CommitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

export const RepositoryBasesSchema = z.array(z.object({
  repository: RepositoryNameSchema,
  ref: BaseRefSchema,
  identity: IdentitySchema.optional(),
}).strict()).max(512).refine(
  (values) => new Set(values.map(({ repository }) => repository)).size === values.length,
  "A repository can have only one base branch.",
);

export const ChatWorktreeGroupSchema = z.object({
  ownerChatId: z.string().uuid(),
  sourceDirectory: z.string().startsWith("/"),
  sourceIdentity: IdentitySchema,
  branch: z.string(),
  repositories: z.array(z.object({
    name: RepositoryNameSchema,
    identity: IdentitySchema,
    baseRef: BaseRefSchema,
    baseCommit: CommitSchema,
    baseSyncWarning: z.string().optional(),
  }).strict()),
}).strict().refine((group) => group.branch === `chat-${group.ownerChatId}`, "Invalid chat worktree branch.");
