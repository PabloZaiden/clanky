import type { WebAppRoute } from "@pablozaiden/webapp/web";
import type { Agent, Chat, Task, TerminalSession, Workspace } from "@/shared";
import { isWorkspaceReadOnly } from "@/shared/workspace";
import { decodeCollaborationResourceReference } from "@/shared/collaboration-reference";

export interface WorkspaceAccessResources {
  workspaces: Workspace[];
  tasks: Task[];
  chats: Chat[];
  agents: Agent[];
  terminalSessions: TerminalSession[];
}

export function isReadOnlyWorkspaceRoute(route: WebAppRoute, resources: WorkspaceAccessResources): boolean {
  const workspaceId = typeof route["workspaceId"] === "string" ? route["workspaceId"]
    : route.view === "compose" && typeof route["scopeId"] === "string" ? route["scopeId"]
      : resources.tasks.find((task) => task.config.id === route["taskId"])?.config.workspaceId
        ?? resources.chats.find((chat) => chat.config.id === route["chatId"])?.config.workspaceId
        ?? resources.agents.find((agent) => agent.config.id === route["agentId"])?.config.workspaceId
        ?? resources.terminalSessions.find((terminal) => terminal.config.id === route["terminalSessionId"])?.config.workspaceId;
  const workspace = resources.workspaces.find((entry) => entry.id === workspaceId);
  if (workspace) return isWorkspaceReadOnly(workspace);
  return [workspaceId, route["taskId"], route["chatId"], route["agentId"], route["terminalSessionId"]]
    .some((id) => typeof id === "string" && Boolean(decodeCollaborationResourceReference(id)));
}

const READ_ONLY_ACTIONS = new Set([
  "open-code-explorer", "open-scratchpad", "open-github", "open-pull-request",
  "export-agent", "harness-activity", "chat-harness-activity",
]);

export function isReadOnlyWorkspaceAction(action: { id?: string }): boolean {
  return action.id !== undefined && READ_ONLY_ACTIONS.has(action.id);
}
