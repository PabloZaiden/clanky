import { z } from "zod";

export const RequestSecretSchema = z.object({
  identifier: z.string().trim().min(1).max(128)
    .describe("Stable logical name within this conversation, e.g. github-token. Not a file path."),
  label: z.string().trim().min(1).max(200).describe("Name of the secret to ask the user for."),
  reason: z.string().trim().min(1).max(1000).describe("Why the CLI needs it and where the user can obtain it."),
}).strict();

export const ReplyToSecretSchema = z.object({
  value: z.string().min(1).nullable(),
}).strict();
