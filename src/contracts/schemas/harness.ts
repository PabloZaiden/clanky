/**
 * Durable ownership identity shared by persistence and harness boundaries.
 */

import { z } from "zod";
import { ExecutionHostBindingSchema } from "./execution-host";
import { HARNESS_ADAPTER_IDS } from "@/shared/harness-events";

export const HarnessConversationBindingSchema = z.object({
  adapter: z.enum(HARNESS_ADAPTER_IDS),
  nativeId: z.string().min(1),
  ownerId: z.string().min(1),
  contextId: z.string().min(1),
  directory: z.string().min(1),
  executionHost: ExecutionHostBindingSchema.optional(),
});

export const HarnessNativeReferencesSchema = z.object({
  adapter: z.enum(HARNESS_ADAPTER_IDS),
  conversationId: z.string().optional(),
  turnId: z.string().optional(),
  messageId: z.string().optional(),
  activityId: z.string().optional(),
  toolCallId: z.string().optional(),
  commandId: z.string().optional(),
});

const AcceptedInputSchema = z.object({
  status: z.enum(["accepted", "delivered"]),
  inputId: z.string(),
  nativeMessageId: z.string().optional(),
  nativeClientInputId: z.string().optional(),
  nativeTurnId: z.string().optional(),
});
const IdentifiedInputSchema = z.union([
  AcceptedInputSchema.extend({ nativeMessageId: z.string().min(1) }),
  AcceptedInputSchema.extend({ nativeClientInputId: z.string().min(1) }),
]);

export const HarnessConversationStateSchema = z.object({
  capabilities: z.object({
    adapter: z.enum(HARNESS_ADAPTER_IDS), experimental: z.boolean(),
    steering: z.enum(["unsupported", "active-session", "expected-turn"]),
    activity: z.enum(["unavailable", "partial", "native"]),
    stopScopes: z.array(z.enum(["child-execution", "command"])),
  }).optional(),
  gitSafety: z.union([
    z.object({ status: z.literal("safe"), observedAt: z.string() }),
    z.object({ status: z.literal("blocked"), reason: z.enum(["active-writers", "unavailable"]), activityIds: z.array(z.string()).max(2001) }),
  ]).optional(),
  gitOutcome: z.object({ status: z.enum(["pending", "succeeded", "failed"]), observedAt: z.string() }).optional(),
  activity: z.union([
    z.object({
      observation: z.literal("available"), coverage: z.enum(["partial", "native"]),
      observedAt: z.string(), principalProcessing: z.boolean(),
      activities: z.array(z.object({
        id: z.string(), parentId: z.string().optional(), spawningToolCallId: z.string().optional(),
        kind: z.enum(["subagent", "process", "external"]), description: z.string(),
        status: z.enum(["queued", "running", "waiting", "idle", "stopping", "stopped", "completed", "failed", "unknown"]),
        ownership: z.enum(["owned", "unverified"]), workspaceWrites: z.enum(["possible", "none", "unknown"]),
        native: HarnessNativeReferencesSchema, requestedModel: z.string().optional(),
        effectiveModel: z.string().optional(), lastActivity: z.string().optional(),
      })).max(2000),
    }),
    z.object({ observation: z.literal("unavailable"), reason: z.enum(["unsupported", "disconnected", "gap"]) }),
  ]).optional(),
  cleanup: z.union([
    z.object({ status: z.literal("settled"), observedAt: z.string() }),
    z.object({ status: z.literal("pending"), activityIds: z.array(z.string()).max(2000) }),
    z.object({ status: z.literal("unavailable"), reason: z.enum(["unsupported", "disconnected", "gap"]) }),
  ]).optional(),
  inputs: z.array(z.object({
    conversation: HarnessConversationBindingSchema, submittedAt: z.string(),
    admission: z.union([
      IdentifiedInputSchema,
      z.object({ status: z.literal("rejected"), inputId: z.string(), code: z.enum(["not-running", "turn-changed", "unsupported"]) }),
      z.object({ status: z.literal("unknown"), inputId: z.string() }),
    ]),
  })).max(1000).optional(),
  integrity: z.literal("invalid").optional(),
});
