import type { WebAppRoute } from "@pablozaiden/webapp/web";
import type { Automation, Chat, Task, TerminalSession, Workspace } from "@/shared";
import { isWorkspaceReadOnly } from "@/shared/workspace";
import { decodeCollaborationResourceReference } from "@/shared/collaboration-reference";
import { getClankyClientCapabilities } from "../client-sdk/capabilities";

export interface WorkspaceAccessResources {
  workspaces: Workspace[];
  tasks: Task[];
  chats: Chat[];
  automations: Automation[];
  terminalSessions: TerminalSession[];
}

export function isReadOnlyWorkspaceRoute(route: WebAppRoute, resources: WorkspaceAccessResources): boolean {
  if (!getClankyClientCapabilities().taskExecution && (
    typeof route["taskId"] === "string"
    || resources.chats.some((chat) => chat.config.id === route["chatId"] && Boolean(chat.config.taskId))
    || route.view === "compose" && route["kind"] === "task"
  )) return true;
  // Trash actions check the deleted chat's workspace grant independently.
  if (route.view === "trash") return false;
  const workspaceId = typeof route["workspaceId"] === "string" ? route["workspaceId"]
    : route.view === "compose" && typeof route["scopeId"] === "string" ? route["scopeId"]
      : resources.tasks.find((task) => task.config.id === route["taskId"])?.config.workspaceId
        ?? resources.chats.find((chat) => chat.config.id === route["chatId"])?.config.workspaceId
        ?? resources.automations.find((automation) => automation.config.id === route["automationId"])?.config.workspaceId
        ?? resources.terminalSessions.find((terminal) => terminal.config.id === route["terminalSessionId"])?.config.workspaceId;
  const workspace = resources.workspaces.find((entry) => entry.id === workspaceId);
  if (workspace) return isWorkspaceReadOnly(workspace);
  return [workspaceId, route["taskId"], route["chatId"], route["automationId"], route["terminalSessionId"]]
    .some((id) => typeof id === "string" && Boolean(decodeCollaborationResourceReference(id)));
}

const READ_ONLY_ACTIONS = new Set([
  "open-code-explorer", "open-pull-request",
  "export-automation", "harness-activity", "chat-harness-activity",
]);

export function isReadOnlyWorkspaceAction(action: { id?: string }): boolean {
  return action.id !== undefined && READ_ONLY_ACTIONS.has(action.id);
}
