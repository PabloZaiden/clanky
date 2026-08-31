import type { Agent, Chat, Workspace } from "@/shared";
import type { useChats, useTasks } from "../../hooks";
import type { UseTerminalSessionsResult } from "../../hooks/useTerminalSessions";
import { getTaskStatusPill, isWorkspaceHistoryTask } from "../../utils";
import {
  StatusBadge,
  getChatStatusBadgeVariant,
  formatStatusLabel,
  getTerminalSessionStatusBadgeVariant,
  getTerminalSessionStatusLabel,
} from "../common";
import { EmptyState, Panel, type WebAppRoute } from "@pablozaiden/webapp/web";
import { ConfiguredAgentsSection } from "../ConfiguredAgentsSection";
import { isEffectivelyPrivate, shouldObscurePrivateItem } from "../../lib/private-items";
import { ClankyListRow } from "./clanky-list-row";

export function WorkspaceView({
  workspace,
  relatedTasks,
  relatedChats,
  relatedTerminalSessions,
  relatedAgents,
  agentsLoading,
  agentsError,
  onNavigate,
  showPrivateItems = false,
}: {
  workspace: Workspace;
  relatedTasks: ReturnType<typeof useTasks>["tasks"];
  relatedChats: ReturnType<typeof useChats>["chats"];
  relatedTerminalSessions: UseTerminalSessionsResult["sessions"];
  relatedAgents: Agent[];
  agentsLoading: boolean;
  agentsError: string | null;
  onNavigate: (route: WebAppRoute) => void;
  showPrivateItems?: boolean;
}) {
  const activityTasks = workspace.workspaceType === "git"
    ? relatedTasks.filter((task) => !isWorkspaceHistoryTask(task.state.status))
    : [];
  const historyTasks = workspace.workspaceType === "git"
    ? relatedTasks.filter((task) => isWorkspaceHistoryTask(task.state.status))
    : [];
  const activityChats = relatedChats.filter((chat) => chat.state.status !== "done");
  const historyChats = relatedChats.filter((chat) => chat.state.status === "done");
  const hasActivity = activityTasks.length > 0 || activityChats.length > 0 || relatedTerminalSessions.length > 0;
  const historyDescription = "Completed tasks and chats marked as done.";

  function renderTaskRow(task: ReturnType<typeof useTasks>["tasks"][number]) {
    const route: WebAppRoute = { view: "task", taskId: task.config.id };
    const statusPill = getTaskStatusPill(task);
    const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(task.config, [workspace]), showPrivateItems);
    return (
      <ClankyListRow
        key={task.config.id}
        title={task.config.name}
        description="Task"
        badge={<StatusBadge variant={statusPill.variant}>{statusPill.label}</StatusBadge>}
        onClick={!privateHidden ? () => onNavigate(route) : undefined}
        privateHidden={privateHidden}
      />
    );
  }

  function renderChatRow(chat: Chat) {
    const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(chat.config, [workspace]), showPrivateItems);
    return (
      <ClankyListRow
        key={chat.config.id}
        title={chat.config.name}
        description="Chat"
        badge={<StatusBadge variant={getChatStatusBadgeVariant(chat.state.status)}>{formatStatusLabel(chat.state.status)}</StatusBadge>}
        onClick={!privateHidden ? () => onNavigate({ view: "chat", chatId: chat.config.id }) : undefined}
        privateHidden={privateHidden}
      />
    );
  }

  return (
    <div className="min-w-0 space-y-6">
      <Panel data-testid="workspace-activity-card" title="Activity">
        <div>
          {hasActivity ? (
            <div className="space-y-2">
              {activityTasks.map((task) => renderTaskRow(task))}
              {activityChats.map(renderChatRow)}
              {relatedTerminalSessions.map((terminal) => {
                const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(terminal.config, [workspace]), showPrivateItems);
                return (
                  <ClankyListRow
                    key={terminal.config.id}
                    title={terminal.config.name}
                    description={terminal.config.connectionMode === "direct" ? "Direct" : "Persistent"}
                    badge={<StatusBadge variant={getTerminalSessionStatusBadgeVariant(terminal.state.status)}>{getTerminalSessionStatusLabel(terminal.state.status)}</StatusBadge>}
                    onClick={!privateHidden ? () => onNavigate({ view: "terminal", terminalSessionId: terminal.config.id }) : undefined}
                    privateHidden={privateHidden}
                  />
                );
              })}
            </div>
          ) : (
            <EmptyState title="No active items" description="There are no active tasks, chats, or sessions in this workspace right now." />
          )}
        </div>
      </Panel>

      <ConfiguredAgentsSection
        agents={relatedAgents}
        loading={agentsLoading}
        error={agentsError}
        title="Configured Agents"
        onSelectAgent={(agentId) => onNavigate({ view: "agent", agentId })}
        isAgentPrivateHidden={(agent) => shouldObscurePrivateItem(isEffectivelyPrivate(agent.config, [workspace]), showPrivateItems)}
      />

      {historyTasks.length > 0 || historyChats.length > 0 ? (
        <Panel data-testid="workspace-history-card" title="History" description={historyDescription}>
          <div className="space-y-2">
            {historyTasks.map((task) => renderTaskRow(task))}
            {historyChats.map(renderChatRow)}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
