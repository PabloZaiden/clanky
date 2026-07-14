import type { Agent, Chat, SshServer, Workspace } from "@/shared";
import { findRegisteredSshServer } from "@/shared/settings";
import type { useChats, useTasks, useSshSessions } from "../../hooks";
import { getTaskStatusPill, isWorkspaceHistoryTask } from "../../utils";
import {
  StatusBadge,
  getChatStatusBadgeVariant,
  getSshSessionStatusBadgeVariant,
  getSshSessionStatusLabel,
} from "../common";
import { DataList, DataListRow, EmptyState, Panel, type WebAppRoute } from "@pablozaiden/webapp/web";
import { ConfiguredAgentsSection } from "../ConfiguredAgentsSection";
import { getPrivateContainerClassName, isEffectivelyPrivate, shouldObscurePrivateItem } from "../../lib/private-items";

function getWorkspaceHeaderServerLabel(
  workspace: Workspace,
  registeredSshServers: readonly SshServer[],
): string {
  if (workspace.serverSettings.agent.transport === "stdio") {
    return "stdio";
  }

  const hostname = workspace.serverSettings.agent.hostname.trim() || "127.0.0.1";
  const port = workspace.serverSettings.agent.port ?? 22;
  const registeredServer = findRegisteredSshServer(hostname, registeredSshServers);
  const serverLabel = registeredServer?.config.name ?? hostname;

  return port === 22 ? serverLabel : `${serverLabel}:${port}`;
}

export function WorkspaceView({
  workspace,
  relatedTasks,
  relatedChats,
  relatedSessions,
  relatedAgents,
  agentsLoading,
  agentsError,
  registeredSshServers,
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
  const serverLabel = getWorkspaceHeaderServerLabel(workspace, registeredSshServers);
  const activityTasks = relatedTasks.filter((task) => !isWorkspaceHistoryTask(task.state.status));
  const historyTasks = relatedTasks.filter((task) => isWorkspaceHistoryTask(task.state.status));
  const hasActivity = activityTasks.length > 0 || relatedChats.length > 0 || relatedSessions.length > 0;
  const historyDescription = "Merged and deleted tasks from this workspace.";
  function renderTaskRow(task: ReturnType<typeof useTasks>["tasks"][number]) {
    const route: WebAppRoute = { view: "task", taskId: task.config.id };
    const statusPill = getTaskStatusPill(task);
    const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(task.config, [workspace]), showPrivateItems);
    return (
      <div
        key={task.config.id}
        className={getPrivateContainerClassName(privateHidden)}
      >
        <DataListRow
          title={task.config.name}
          description="Task"
          badge={<StatusBadge variant={statusPill.variant}>{statusPill.label}</StatusBadge>}
          onClick={privateHidden ? undefined : () => onNavigate(route)}
        />
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-6">
      <div data-testid="workspace-activity-card">
        <Panel title="Activity" description={serverLabel}>
          <DataList>
            {hasActivity ? (
              <>
              {activityTasks.map((task) => renderTaskRow(task))}
              {relatedChats.map((chat: Chat) => {
                const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(chat.config, [workspace]), showPrivateItems);
                return (
                  <div
                    key={chat.config.id}
                    className={getPrivateContainerClassName(privateHidden)}
                  >
                    <DataListRow
                      title={chat.config.name}
                      description="Chat"
                      badge={<StatusBadge variant={getChatStatusBadgeVariant(chat.state.status)}>{chat.state.status}</StatusBadge>}
                      onClick={privateHidden ? undefined : () => onNavigate({ view: "chat", chatId: chat.config.id })}
                    />
                  </div>
                );
              })}
              {relatedSessions.map((session) => {
                const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(session.config, [workspace]), showPrivateItems);
                return (
                  <div
                    key={session.config.id}
                    className={getPrivateContainerClassName(privateHidden)}
                  >
                    <DataListRow
                      title={session.config.name}
                      description={session.config.connectionMode === "direct" ? "Direct SSH" : "Persistent SSH"}
                      badge={(
                        <StatusBadge variant={getSshSessionStatusBadgeVariant(session.state.status)}>
                          {getSshSessionStatusLabel(session.state.status)}
                        </StatusBadge>
                      )}
                      onClick={privateHidden ? undefined : () => onNavigate({ view: "ssh", sshSessionId: session.config.id })}
                    />
                  </div>
                );
              })}
              </>
            ) : (
              <EmptyState
                title="No active items"
                description="There are no active tasks, chats, or sessions in this workspace right now."
              />
            )}
          </DataList>
        </Panel>
      </div>

      <ConfiguredAgentsSection
        agents={relatedAgents}
        loading={agentsLoading}
        error={agentsError}
        title="Configured Agents"
        onSelectAgent={(agentId) => onNavigate({ view: "agent", agentId })}
        isAgentPrivateHidden={(agent) => shouldObscurePrivateItem(isEffectivelyPrivate(agent.config, [workspace]), showPrivateItems)}
      />

      {historyTasks.length > 0 ? (
        <div data-testid="workspace-history-card">
          <Panel title="History" description={historyDescription}>
            <DataList>
              {historyTasks.map((task) => renderTaskRow(task))}
            </DataList>
          </Panel>
        </div>
      ) : null}
    </div>
  );
}
