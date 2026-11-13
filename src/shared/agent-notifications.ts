export const AGENT_NOTIFICATION_INSTRUCTIONS =
  "Use clanky_send_notification only when the user explicitly requests a notification. "
  + "A configured webhook or an ordinary completion, failure, progress update, or need for input is not permission to notify. "
  + "Do not include secrets in notifications. Report delivery failures to the user; never automatically retry an uncertain send.";

export const NOTIFICATION_EVENT_LABELS = {
  error: "Errors",
  question: "Questions",
  secret: "Secret requests",
  approval: "Permission and approval requests",
  completed: "Finished chats",
} as const;

export type NotificationEventKind = keyof typeof NOTIFICATION_EVENT_LABELS;

export interface NotificationEventPreferences {
  error: boolean;
  question: boolean;
  secret: boolean;
  approval: boolean;
  completed: boolean;
}

export const DEFAULT_NOTIFICATION_PREFERENCES = {
  enabled: false,
  events: {
    error: false,
    question: false,
    secret: false,
    approval: false,
    completed: false,
  } satisfies NotificationEventPreferences,
};
