import { z } from "zod";
import type { NotificationEventPreferences } from "@/shared/agent-notifications";

export const NotificationEventPreferencesSchema = z.object({
  error: z.boolean(),
  blocked: z.boolean(),
  question: z.boolean(),
  secret: z.boolean(),
  approval: z.boolean(),
  planReady: z.boolean(),
  completed: z.boolean(),
}).strict() satisfies z.ZodType<NotificationEventPreferences>;

export const NotificationPreferencesSchema = z.object({
  enabled: z.boolean(),
  events: NotificationEventPreferencesSchema,
}).strict();

export const NotificationDeliveryErrorSchema = z.object({
  message: z.string(),
  timestamp: z.string(),
}).strict();

export const NotificationWebhookUrlSchema = z.string().trim().min(1).max(4096).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:")
      && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}, "Use an absolute HTTP(S) webhook URL without user credentials or a fragment.");

export const SetAgentNotificationSettingsSchema = z.object({
  webhookUrl: NotificationWebhookUrlSchema.nullable().optional(),
  enabled: z.boolean().optional(),
  events: NotificationEventPreferencesSchema.partial().refine(
    (value) => Object.keys(value).length > 0, "Choose at least one event preference.",
  ).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, "Supply a notification setting.");

export const AgentNotificationSettingsSchema = z.object({
  configured: z.boolean(),
  ...NotificationPreferencesSchema.shape,
  lastDeliveryError: NotificationDeliveryErrorSchema.nullable(),
}).strict();

// Listen's text webhook contract; the control transport also bounds the full request.
export const AgentNotificationSchema = z.object({
  title: z.string().trim().min(1).max(100),
  shortDescription: z.string().trim().min(1).max(500),
  markdownContent: z.string().min(1).refine(
    (value) => new TextEncoder().encode(value).byteLength <= 800 * 1024,
    "Markdown content must not exceed 800 KiB.",
  ),
}).strict();

export type AgentNotificationSettings = z.infer<typeof AgentNotificationSettingsSchema>;
export type SetAgentNotificationSettings = z.infer<typeof SetAgentNotificationSettingsSchema>;
export type NotificationPreferences = z.infer<typeof NotificationPreferencesSchema>;
export type NotificationDeliveryError = z.infer<typeof NotificationDeliveryErrorSchema>;
export type AgentNotification = z.infer<typeof AgentNotificationSchema>;
