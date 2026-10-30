export const AGENT_NOTIFICATION_INSTRUCTIONS =
  "Use clanky_send_notification only when the user explicitly requests a notification. "
  + "A configured webhook or an ordinary completion, failure, progress update, or need for input is not permission to notify. "
  + "Do not include secrets in notifications. Report delivery failures to the user; never automatically retry an uncertain send.";
