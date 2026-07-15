import type { Agent, Chat, SshServer, Workspace } from "@/shared";
import type { useChats, useTasks, useSshSessions } from "../../hooks";
import { getTaskStatusPill, isWorkspaceHistoryTask } from "../../utils";
import {
  StatusBadge,
  getChatStatusBadgeVariant,
  getSshSessionStatusBadgeVariant,
  getSshSessionStatusLabel,
} from "../common";
import { EmptyState, Panel, type WebAppRoute } from "@pablozaiden/webapp/web";
import { ConfiguredAgentsSection } from "../ConfiguredAgentsSection";
import { isEffectivelyPrivate, shouldObscurePrivateItem } from "../../lib/private-items";
import { ClankyListRow } from "./clanky-list-row";

export function WorkspaceView({
  workspace,
  relatedTasks,
  relatedChats,
  relatedSessions,
  relatedAgents,
  agentsLoading,
  agentsError,
  onNavigate,
  showPrivateItems = false,
}: {
  workspace: Workspace;
  relatedTasks: ReturnType<typeof useTasks>["tasks"];
  relatedChats: ReturnType<typeof useChats>["chats"];
  relatedSessions: ReturnType<typeof useSshSessions>["sessions"];
  relatedAgents: Agent[];
  agentsLoading: boolean;
  agentsError: string | null;
  registeredSshServers: readonly SshServer[];
  onNavigate: (route: WebAppRoute) => void;
  showPrivateItems?: boolean;
}) {
  const activityTasks = relatedTasks.filter((task) => !isWorkspaceHistoryTask(task.state.status));
  const historyTasks = relatedTasks.filter((task) => isWorkspaceHistoryTask(task.state.status));
  const hasActivity = activityTasks.length > 0 || relatedChats.length > 0 || relatedSessions.length > 0;
  const historyDescription = "Merged and deleted tasks from this workspace.";

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

  return (
    <div className="min-w-0 space-y-6">
      <Panel data-testid="workspace-activity-card" title="Activity">
        <div>
          {hasActivity ? (
            <div className="space-y-2">
              {activityTasks.map((task) => renderTaskRow(task))}
              {relatedChats.map((chat: Chat) => {
                const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(chat.config, [workspace]), showPrivateItems);
                return (
                  <ClankyListRow
                    key={chat.config.id}
                    title={chat.config.name}
                    description="Chat"
                    badge={<StatusBadge variant={getChatStatusBadgeVariant(chat.state.status)}>{chat.state.status}</StatusBadge>}
                    onClick={!privateHidden ? () => onNavigate({ view: "chat", chatId: chat.config.id }) : undefined}
                    privateHidden={privateHidden}
                  />
                );
              })}
              {relatedSessions.map((session) => {
                const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(session.config, [workspace]), showPrivateItems);
                return (
                  <ClankyListRow
                    key={session.config.id}
                    title={session.config.name}
                    description={session.config.connectionMode === "direct" ? "Direct SSH" : "Persistent SSH"}
                    badge={<StatusBadge variant={getSshSessionStatusBadgeVariant(session.state.status)}>{getSshSessionStatusLabel(session.state.status)}</StatusBadge>}
                    onClick={!privateHidden ? () => onNavigate({ view: "ssh", sshSessionId: session.config.id }) : undefined}
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

      {historyTasks.length > 0 ? (
        <Panel data-testid="workspace-history-card" title="History" description={historyDescription}>
          <div className="space-y-2">{historyTasks.map((task) => renderTaskRow(task))}</div>
        </Panel>
      ) : null}
    </div>
  );
}
