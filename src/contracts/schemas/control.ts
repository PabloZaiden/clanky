import { z } from "zod";
import { ClankyControlContextSchema } from "@/shared/clanky-control";

export const ControlToolInvocationSchema = z.object({
  input: z.unknown(),
  context: ClankyControlContextSchema.optional(),
}).strict();
export const ControlToolsQuerySchema = z.object({ chatId: z.string().min(1).max(500).optional() }).strict();
export const ControlToolsResponseSchema = z.object({
  tools: z.array(z.object({
    name: z.string(), description: z.string(), inputSchema: z.record(z.string(), z.unknown()),
  }).strict()).max(25),
}).strict();
export type ControlToolDefinition = z.infer<typeof ControlToolsResponseSchema>["tools"][number];

export const ExecuteOperationSchema = z.object({
  operationId: z.string().min(1).max(500),
  parameters: z.array(z.object({ name: z.string().min(1).max(100), value: z.string().max(16_384) }).strict()).max(16),
  query: z.array(z.object({ name: z.string().min(1).max(100), value: z.string().max(16_384) }).strict()).max(32),
  bodyJson: z.string().max(40_000).nullable(),
}).strict();
export type ExecuteOperationInput = z.infer<typeof ExecuteOperationSchema>;

export const ControlGrantSelectionSchema = z.discriminatedUnion("level", [
  z.object({ level: z.literal("workspace"), workspaceId: z.string().min(1).max(500) }).strict(),
  z.object({ level: z.literal("general") }).strict(),
]);
export type ControlGrantSelection = z.infer<typeof ControlGrantSelectionSchema>;

export const ControlRequestSnapshotSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["confirmation", "ssh_credential"]),
  status: z.enum(["pending", "running", "completed", "expired"]),
  description: z.string().max(500),
  expiresAt: z.number().int().positive(),
  operation: ExecuteOperationSchema.optional(),
  serverId: z.string().min(1).max(500).optional(),
  serverName: z.string().min(1).max(500).optional(),
  result: z.unknown().optional(),
}).strict();
export type ControlRequestSnapshot = z.infer<typeof ControlRequestSnapshotSchema>;

export const ControlDecisionSchema = z.object({ approved: z.boolean() }).strict();
export const ControlCredentialHandoffSchema = z.object({
  credentialToken: z.string().min(1).max(4096).nullable(),
}).strict();
export const CreateControlCredentialSchema = z.object({
  name: z.string().trim().min(1).max(100),
  grant: ControlGrantSelectionSchema,
  expiresInDays: z.number().int().min(1).max(90).default(30),
}).strict();
export const ControlCredentialSummarySchema = z.object({
  id: z.string().min(1).max(500),
  name: z.string(),
  grant: ControlGrantSelectionSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
}).strict();
export type ControlCredentialSummary = z.infer<typeof ControlCredentialSummarySchema>;
