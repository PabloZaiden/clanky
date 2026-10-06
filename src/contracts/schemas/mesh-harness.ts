/**
 * Mesh native host contract. Never interpreted as ACP JSON-RPC.
 */
import { z } from "zod";
import { HarnessConversationBindingSchema, HarnessEventScopeSchema, HarnessQuestionInfoSchema } from "./harness";
import { MESH_PROTOCOL_VERSION } from "@/shared/mesh-protocol";

const Id = z.string().min(1).max(500);
const Path = z.string().min(1).max(16_384);
const Prompt = z.object({
  parts: z.array(z.union([
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("image"), mimeType: Id, data: z.string(), filename: z.string().optional() }),
    z.object({ type: z.literal("resource"), resource: z.object({ uri: Path, mimeType: z.string().optional(), text: z.string() }) }),
    z.object({ type: z.literal("resource"), resource: z.object({ uri: Path, mimeType: z.string().optional(), blob: z.string() }) }),
  ])).min(1).max(100),
  model: z.object({ providerID: Id, modelID: Id, variant: z.string().optional() }).optional(),
});
const Session = z.object({ sessionId: Id });
const InputRecovery = z.object({
  inputId: Id, nativeMessageId: Id.optional(), nativeClientInputId: Id.optional(), nativeTurnId: Id.optional(),
});

export const MeshHarnessOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("capabilities") }),
  z.object({ operation: z.literal("create"), options: z.object({
    directory: Path, title: z.string().max(1000).optional(), model: Id.optional(),
    ownership: HarnessConversationBindingSchema.omit({ adapter: true, nativeId: true, directory: true }),
  }) }),
  z.object({ operation: z.literal("resume"), binding: HarnessConversationBindingSchema }),
  Session.extend({ operation: z.literal("get") }),
  Session.extend({ operation: z.literal("delete") }),
  Session.extend({ operation: z.literal("prompt"), prompt: Prompt, synchronous: z.boolean().optional() }),
  Session.extend({ operation: z.literal("abort") }),
  Session.extend({ operation: z.literal("activity") }),
  Session.extend({ operation: z.literal("stop"), activityId: Id }),
  Session.extend({ operation: z.literal("settle") }),
  Session.extend({ operation: z.literal("steer"), request: z.object({
    inputId: Id, prompt: Prompt, expectedTurnId: Id.optional(),
  }) }),
  Session.extend({ operation: z.literal("reconcile"), request: InputRecovery }),
  Session.extend({ operation: z.literal("config"), configId: Id, value: z.string().max(1000) }),
  Session.extend({ operation: z.literal("model"), modelId: Id }),
  Session.extend({ operation: z.literal("permission"), requestId: Id, response: Id }),
  Session.extend({ operation: z.literal("question"), requestId: Id, answers: z.array(z.array(z.string().max(10000)).max(100)).max(100) }),
  z.object({ operation: z.literal("models"), directory: Path }),
  z.object({ operation: z.literal("variants"), directory: Path, modelId: Id }),
]);
export type MeshHarnessOperation = z.infer<typeof MeshHarnessOperationSchema>;

export const MeshHarnessEncryptedPayloadSchema = z.object({
  __clankyMeshEncrypted: z.literal(true), version: z.literal(1),
  wrappedKey: z.string().min(1).max(16_384), iv: z.string().min(1).max(128),
  authTag: z.string().min(1).max(128), ciphertext: z.string().max(4 * 1024 * 1024),
}).strict();
export const MeshHarnessEnvelopeSchema = z.object({
  protocolVersion: z.literal(MESH_PROTOCOL_VERSION), sessionId: Id,
  sessionToken: z.string().min(32).max(256), requestId: Id,
  encryptedPayload: MeshHarnessEncryptedPayloadSchema,
}).strict();
export const MeshHarnessEventsRequestSchema = MeshHarnessEnvelopeSchema.extend({ conversationId: Id, encryptedPayload: z.null() });

export const MeshHarnessEventSchema = z.intersection(z.discriminatedUnion("type", [
  z.object({ type: z.literal("activity.changed") }),
  z.object({ type: z.literal("user.message"), content: z.string() }),
  z.object({ type: z.literal("message.start"), messageId: Id }),
  z.object({ type: z.literal("message.delta"), content: z.string() }),
  z.object({ type: z.literal("message.complete"), content: z.string() }),
  z.object({ type: z.literal("reasoning.delta"), content: z.string() }),
  z.object({ type: z.literal("tool.start"), toolCallId: Id.optional(), toolName: Id, input: z.unknown() }),
  z.object({ type: z.literal("tool.complete"), toolCallId: Id.optional(), toolName: Id, input: z.unknown().optional(), output: z.unknown() }),
  z.object({ type: z.literal("request.error"), code: Id, message: z.string(), details: z.record(z.string(), z.unknown()).optional() }),
  z.object({ type: z.literal("error"), code: Id.optional(), message: z.string(), details: z.record(z.string(), z.unknown()).optional() }),
  z.object({ type: z.literal("permission.asked"), requestId: Id, sessionId: Id, permission: Id, patterns: z.array(z.string()).max(1000) }),
  z.object({ type: z.literal("question.asked"), requestId: Id, sessionId: Id,
    questions: z.array(HarnessQuestionInfoSchema).min(1).max(100), blocking: z.boolean().optional(),
    responseMode: z.enum(["callback", "message"]).optional(),
  }),
  z.object({ type: z.literal("question.resolved"), requestId: Id, outcome: z.enum(["answered", "cancelled", "expired"]) }),
  z.object({ type: z.literal("prompt.complete"), outcome: z.enum(["completed", "interrupted"]) }),
  z.object({ type: z.literal("session.status"), sessionId: Id, status: z.enum(["idle", "busy", "retry"]),
    attempt: z.number().optional(), message: z.string().optional(), stopReason: z.string().optional(),
  }),
]), z.object({
  scope: HarnessEventScopeSchema,
  timestamp: z.iso.datetime().optional(),
  sourceEventId: Id.optional(), sourceSequence: z.number().int().nonnegative().optional(),
}));
