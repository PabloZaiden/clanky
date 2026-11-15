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

export const NOTIFICATION_TEMPLATE_VARIABLES = ["title", "shortDescription", "markdownContent"] as const;
export const NOTIFICATION_TEMPLATE_MAX_BYTES = 64 * 1024;
export const NOTIFICATION_PAYLOAD_MAX_BYTES = 1024 * 1024;
export const DEFAULT_NOTIFICATION_TEMPLATE = '{\n  "text": "{{title}}\\n{{markdownContent}}"\n}';

type NotificationTemplateVariable = typeof NOTIFICATION_TEMPLATE_VARIABLES[number];
type NotificationTemplateContent = Record<NotificationTemplateVariable, string>;

function isTemplateVariable(value: string): value is NotificationTemplateVariable {
  return NOTIFICATION_TEMPLATE_VARIABLES.some((variable) => variable === value);
}

export function notificationTemplateError(template: string): string | null {
  if (new TextEncoder().encode(template).byteLength > NOTIFICATION_TEMPLATE_MAX_BYTES) {
    return "The JSON template must not exceed 64 KiB.";
  }
  let error: string | null = null;
  try {
    const parsed: unknown = JSON.parse(template);
    JSON.stringify(parsed, (_key, value: unknown) => {
      if (typeof value === "string") {
        for (const match of value.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
          if (!isTemplateVariable(match[1]!.trim())) {
            error = "Use only {{title}}, {{shortDescription}}, and {{markdownContent}} in JSON string values.";
          }
        }
      }
      return value;
    });
  } catch (cause) {
    if (cause instanceof SyntaxError) return "Enter a valid JSON template.";
    if (cause instanceof RangeError) return "The JSON template is too deeply nested.";
    throw cause;
  }
  return error;
}

export function renderNotificationTemplate(template: string, content: NotificationTemplateContent):
  { success: true; body: string } | { success: false; error: string } {
  const parsed: unknown = JSON.parse(template);
  const encoder = new TextEncoder();
  const encodedStringBytes = (value: string) => encoder.encode(JSON.stringify(value)).byteLength - 2;
  const replacementBytes = {
    title: encodedStringBytes(content.title),
    shortDescription: encodedStringBytes(content.shortDescription),
    markdownContent: encodedStringBytes(content.markdownContent),
  };
  let bytes = encoder.encode(JSON.stringify(parsed)).byteLength;
  // Measure escaped output before allocating strings with repeated large content.
  JSON.stringify(parsed, (_key, value: unknown) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/\{\{([\s\S]*?)\}\}/g)) {
        const variable = match[1]!.trim();
        if (!isTemplateVariable(variable)) throw new Error("Invalid notification template variable.");
        bytes += replacementBytes[variable] - encodedStringBytes(match[0]);
      }
    }
    return value;
  });
  if (bytes > NOTIFICATION_PAYLOAD_MAX_BYTES) {
    return { success: false, error: "The rendered webhook payload must not exceed 1 MiB." };
  }
  return {
    success: true,
    body: JSON.stringify(parsed, (_key, value: unknown) => typeof value === "string"
      ? value.replace(/\{\{([\s\S]*?)\}\}/g, (_match, name: string) => {
        const variable = name.trim();
        if (!isTemplateVariable(variable)) throw new Error("Invalid notification template variable.");
        return content[variable];
      }) : value),
  };
}
