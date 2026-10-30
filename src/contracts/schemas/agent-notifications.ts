import { z } from "zod";

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
  webhookUrl: NotificationWebhookUrlSchema.nullable(),
}).strict();

export const AgentNotificationSettingsSchema = z.object({
  configured: z.boolean(),
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
export type AgentNotification = z.infer<typeof AgentNotificationSchema>;
