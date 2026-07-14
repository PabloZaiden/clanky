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
import type { ShellRoute } from "./shell-types";
import { ShellPanel } from "./shell-panel";
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
  headerOffsetClassName,
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
  headerOffsetClassName?: string;
  onNavigate: (route: ShellRoute) => void;
  showPrivateItems?: boolean;
}) {
  const serverLabel = getWorkspaceHeaderServerLabel(workspace, registeredSshServers);
  const activityTasks = relatedTasks.filter((task) => !isWorkspaceHistoryTask(task.state.status));
  const historyTasks = relatedTasks.filter((task) => isWorkspaceHistoryTask(task.state.status));
  const hasActivity = activityTasks.length > 0 || relatedChats.length > 0 || relatedSessions.length > 0;
  const activityRowClassName = "flex min-w-0 w-full items-center gap-3 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-left transition hover:border-gray-300 hover:bg-gray-100 dark:border-gray-800 dark:bg-neutral-900 dark:hover:border-gray-700 dark:hover:bg-neutral-800";
  const historyDescription = "Merged and deleted tasks from this workspace.";
  function renderTaskRow(task: ReturnType<typeof useTasks>["tasks"][number]) {
    const route: ShellRoute = { view: "task", taskId: task.config.id };
    const statusPill = getTaskStatusPill(task);
    const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(task.config, [workspace]), showPrivateItems);
    return (
      <button
        key={task.config.id}
        type="button"
        disabled={privateHidden}
        onClick={() => onNavigate(route)}
        className={`${activityRowClassName} ${getPrivateContainerClassName(privateHidden)}`}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
            {task.config.name}
          </span>
          <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
            Task
          </span>
        </span>
        <StatusBadge className="ml-auto shrink-0" variant={statusPill.variant}>
          {statusPill.label}
        </StatusBadge>
      </button>
    );
  }

  return (
    <ShellPanel
      eyebrow="Workspace"
      title={workspace.name}
      description={serverLabel}
      variant="compact"
      headerOffsetClassName={headerOffsetClassName}
    >
      <div className="min-w-0 space-y-6">
        <div
          data-testid="workspace-activity-card"
          className="space-y-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50"
        >
          <div className="flex flex-col gap-1">
            <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">Activity</h2>
          </div>
          {hasActivity ? (
            <div className="space-y-2">
              {activityTasks.map((task) => renderTaskRow(task))}
              {relatedChats.map((chat: Chat) => {
                const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(chat.config, [workspace]), showPrivateItems);
                return (
                  <button
                    key={chat.config.id}
                    type="button"
                    disabled={privateHidden}
                    onClick={() => onNavigate({ view: "chat", chatId: chat.config.id })}
                    className={`${activityRowClassName} ${getPrivateContainerClassName(privateHidden)}`}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                        {chat.config.name}
                      </span>
                      <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                        Chat
                      </span>
                    </span>
                    <StatusBadge className="ml-auto shrink-0" variant={getChatStatusBadgeVariant(chat.state.status)}>
                      {chat.state.status}
                    </StatusBadge>
                  </button>
                );
              })}
              {relatedSessions.map((session) => {
                const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(session.config, [workspace]), showPrivateItems);
                return (
                  <button
                    key={session.config.id}
                    type="button"
                    disabled={privateHidden}
                    onClick={() => onNavigate({ view: "ssh", sshSessionId: session.config.id })}
                    className={`${activityRowClassName} ${getPrivateContainerClassName(privateHidden)}`}
                  >
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
                        {session.config.name}
                      </span>
                      <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                        {session.config.connectionMode === "direct" ? "Direct SSH" : "Persistent SSH"}
                      </span>
                    </span>
                    <StatusBadge
                      className="ml-auto shrink-0"
                      variant={getSshSessionStatusBadgeVariant(session.state.status)}
                    >
                      {getSshSessionStatusLabel(session.state.status)}
                    </StatusBadge>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-gray-600 dark:text-gray-400">No active items in this workspace right now.</p>
          )}
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
          <div
            data-testid="workspace-history-card"
            className="space-y-4 rounded-2xl border border-gray-200 bg-gray-50 p-5 dark:border-gray-800 dark:bg-neutral-950/50"
          >
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold text-gray-950 dark:text-gray-100">History</h2>
              <p className="text-sm text-gray-600 dark:text-gray-400">{historyDescription}</p>
            </div>
            <div className="space-y-2">
              {historyTasks.map((task) => renderTaskRow(task))}
            </div>
          </div>
        ) : null}
      </div>
    </ShellPanel>
  );
}
