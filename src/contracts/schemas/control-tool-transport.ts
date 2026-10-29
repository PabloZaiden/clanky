import { z } from "zod";
import { ControlToolInvocationSchema } from "./control";

export const ControlToolRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("list"), chatId: z.string().min(1).max(500).optional() }).strict(),
  ControlToolInvocationSchema.extend({
    operation: z.literal("call"), name: z.string().regex(/^[A-Za-z0-9_-]+$/).max(128),
  }).strict(),
]);
export type ControlToolRequest = z.infer<typeof ControlToolRequestSchema>;

export const ControlToolFailureSchema = z.object({
  ok: z.literal(false),
  completion: z.enum(["not_executed", "outcome_unknown"]),
  error: z.object({
    code: z.string().regex(/^[a-z][a-z0-9_]{0,100}$/),
    message: z.string().min(1).max(1000),
  }).strict(),
}).strict();
export type ControlToolFailure = z.infer<typeof ControlToolFailureSchema>;

export const ControlToolReplySchema = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }).strict(),
  ControlToolFailureSchema,
]);
export type ControlToolReply = z.infer<typeof ControlToolReplySchema>;
