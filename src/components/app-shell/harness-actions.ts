import type { ActionMenuItem, WebAppRoute } from "@pablozaiden/webapp/web";
import type { HarnessCapabilities } from "@/shared/harness-control";

export function harnessActivityActions({
  route,
  capabilities,
  onOpenActivity,
  embeddedChat = false,
}: {
  route: WebAppRoute;
  capabilities?: HarnessCapabilities;
  onOpenActivity: (route: WebAppRoute) => void;
  embeddedChat?: boolean;
}): ActionMenuItem[] {
  return capabilities && capabilities.activity !== "unavailable" ? [{
    id: embeddedChat ? "chat-harness-activity" : "harness-activity",
    label: embeddedChat ? "Chat activity" : "Activity",
    onAction: () => onOpenActivity(route),
  }] : [];
}
