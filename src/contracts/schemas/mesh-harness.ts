/**
 * Mesh native host contract. Never interpreted as ACP JSON-RPC.
 */
import { z } from "zod";
import { HarnessActivitySchema, HarnessConversationBindingSchema, HarnessEventScopeSchema, HarnessQuestionInfoSchema } from "./harness";
import { MessageAttachmentsSchema } from "./task";
import { MeshProtocolVersionSchema } from "./mesh-protocol";
import { ClankyControlContextSchema } from "@/shared/clanky-control";
import { ControlToolRequestSchema, ControlToolReplySchema } from "./control-tool-transport";
import {
  HARNESS_HISTORY_MAX_BYTES,
  HARNESS_HISTORY_MAX_EVENTS,
  type HarnessSessionHistory,
} from "@/shared/harness-history";
import {
  MESSAGE_ATTACHMENT_MAX_BYTES,
  MESSAGE_IMAGE_ALLOWED_MIME_TYPES,
} from "@/shared/message-attachments";

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
  controlContext: ClankyControlContextSchema.optional(),
});
const Session = z.object({ sessionId: Id });
const InputRecovery = z.object({
  inputId: Id, nativeMessageId: Id.optional(), nativeClientInputId: Id.optional(), nativeTurnId: Id.optional(),
});
const ProviderImageAttachmentsSchema = MessageAttachmentsSchema.superRefine((attachments, ctx) => {
  attachments.forEach((attachment, index) => {
    if (!(MESSAGE_IMAGE_ALLOWED_MIME_TYPES as readonly string[]).includes(attachment.mimeType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index, "mimeType"],
        message: "provider output attachments must be supported images",
      });
    }
  });
});
const ProviderImageFileReferenceSchema = z.object({
  path: Path,
  attachment: z.object({
    id: z.string().min(1),
    filename: z.string().min(1),
    mimeType: z.string().min(1),
    size: z.number().int().positive().max(MESSAGE_ATTACHMENT_MAX_BYTES),
  }).superRefine((attachment, ctx) => {
    if (!(MESSAGE_IMAGE_ALLOWED_MIME_TYPES as readonly string[]).includes(attachment.mimeType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mimeType"],
        message: "provider image file references must use a supported image MIME type",
      });
    }
  }),
}).strict();

export const MeshHarnessOperationSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("capabilities") }),
  z.object({
    operation: z.literal("control.result"),
    controlRequestId: z.string().uuid(),
    reply: ControlToolReplySchema,
  }).strict(),
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
  Session.extend({ operation: z.literal("usage") }),
  Session.extend({ operation: z.literal("history"), cursor: Id.optional() }),
  Session.extend({ operation: z.literal("subagent-history"), activityId: Id, cursor: Id.optional() }),
  Session.extend({ operation: z.literal("stop"), activityId: Id }),
  Session.extend({ operation: z.literal("settle") }),
  Session.extend({ operation: z.literal("steer"), request: z.object({
    inputId: Id, prompt: Prompt, expectedTurnId: Id.optional(), clientId: z.string().uuid().optional(),
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

const MeshHarnessEnvelopeBaseSchema = z.object({
  sessionId: Id,
  sessionToken: z.string().min(32).max(256), requestId: Id,
});
export const MeshHarnessEnvelopeSchema = MeshHarnessEnvelopeBaseSchema.extend({
  protocolVersion: MeshProtocolVersionSchema,
  payload: MeshHarnessOperationSchema,
}).strict();
export const MeshHarnessEventsRequestSchema = z.union([
  MeshHarnessEnvelopeBaseSchema.extend({
    protocolVersion: MeshProtocolVersionSchema, conversationId: Id,
  }).strict(),
  MeshHarnessEnvelopeBaseSchema.extend({
    protocolVersion: MeshProtocolVersionSchema, channel: z.literal("control"),
  }).strict(),
]);

export const MeshHarnessControlEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("request"), requestId: z.string().uuid(), request: ControlToolRequestSchema }).strict(),
  z.object({ type: z.literal("cancel"), requestId: z.string().uuid() }).strict(),
]);
export type MeshHarnessControlEvent = z.infer<typeof MeshHarnessControlEventSchema>;

export const MeshHarnessEventSchema = z.intersection(z.discriminatedUnion("type", [
  z.object({ type: z.literal("activity.changed"), activity: HarnessActivitySchema.optional() }),
  z.object({ type: z.literal("user.message"), content: z.string(), messageId: Id.optional() }),
  z.object({ type: z.literal("message.start"), messageId: Id }),
  z.object({ type: z.literal("message.delta"), content: z.string(), messageId: Id.optional() }),
  z.object({
    type: z.literal("message.complete"),
    content: z.string(),
    messageId: Id.optional(),
    attachments: ProviderImageAttachmentsSchema.optional(),
    providerImageFile: ProviderImageFileReferenceSchema.optional(),
  }),
  z.object({ type: z.literal("reasoning.delta"), content: z.string(), reasoningId: z.string().min(1).optional(), complete: z.boolean().optional() }),
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

export const MeshHarnessSessionHistorySchema = z.object({
  events: z.array(MeshHarnessEventSchema).max(HARNESS_HISTORY_MAX_EVENTS),
  principalProcessing: z.boolean(),
  nextCursor: Id.optional(),
}).strict().superRefine((history, ctx) => {
  if (new TextEncoder().encode(JSON.stringify(history)).byteLength > HARNESS_HISTORY_MAX_BYTES) {
    ctx.addIssue({ code: "custom", message: "Native history exceeds its byte limit." });
  }
  for (let index = 0; index < history.events.length; index += 2) {
    const start = history.events[index]!;
    const complete = history.events[index + 1];
    const pair = start.type === "message.start"
      ? complete?.type === "message.complete" && complete.messageId === start.messageId
      : start.type === "tool.start" && start.toolCallId
        && complete?.type === "tool.complete" && complete.toolCallId === start.toolCallId
        && complete.toolName === start.toolName;
    if (!pair || start.scope.kind !== "principal" || complete?.scope.kind !== "principal") {
      ctx.addIssue({ code: "custom", path: ["events", index], message: "Native history requires completed principal message/tool pairs." });
    }
  }
}).transform((history) => history as HarnessSessionHistory);

export const MeshHarnessSubagentHistorySchema = z.object({
  events: z.array(MeshHarnessEventSchema).max(HARNESS_HISTORY_MAX_EVENTS),
  processing: z.boolean(),
  nextCursor: Id.optional(),
}).strict().superRefine((history, ctx) => {
  if (new TextEncoder().encode(JSON.stringify(history)).byteLength > HARNESS_HISTORY_MAX_BYTES
    || history.events.some((event) => event.scope.kind !== "child")) {
    ctx.addIssue({ code: "custom", message: "Invalid or oversized native child history." });
  }
});
