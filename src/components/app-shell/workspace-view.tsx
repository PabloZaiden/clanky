import { useEffect, useState } from "react";
import type { Agent, Chat, PublicWorkspace, Workspace } from "@/shared";
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
import { EmptyState, ErrorState, LoadingState, Panel, type WebAppRoute } from "@pablozaiden/webapp/web";
import { ConfiguredAgentsSection } from "../ConfiguredAgentsSection";
import {
  isEffectivelyPrivate,
  shouldObscurePrivateItem,
} from "../../lib/private-items";
import { ClankyListRow } from "./clanky-list-row";
import { apiRequest } from "../../lib/api-client";
import { MarkdownRenderer } from "../MarkdownRenderer";

type WorkspaceScratchpadPreviewState =
  | { workspaceId: string; status: "loading" }
  | { workspaceId: string; status: "loaded"; content: string }
  | { workspaceId: string; status: "error"; error: string };

function useWorkspaceScratchpadPreview(
  workspaceId: string,
  enabled: boolean,
): WorkspaceScratchpadPreviewState | null {
  const [preview, setPreview] = useState<WorkspaceScratchpadPreviewState | null>(() => (
    enabled ? { workspaceId, status: "loading" } : null
  ));

  useEffect(() => {
    if (!enabled) {
      setPreview(null);
      return;
    }

    const controller = new AbortController();
    setPreview({ workspaceId, status: "loading" });

    async function loadScratchpad(): Promise<void> {
      try {
        const workspace = await apiRequest<PublicWorkspace>(
          `/api/workspaces/${encodeURIComponent(workspaceId)}`,
          {
            signal: controller.signal,
            action: "Load workspace Scratchpad preview",
            fallbackMessage: "Failed to load workspace Scratchpad preview",
          },
        );
        if (!controller.signal.aborted) {
          setPreview({ workspaceId, status: "loaded", content: workspace.scratchpad });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setPreview({ workspaceId, status: "error", error: String(error) });
        }
      }
    }

    void loadScratchpad();
    return () => controller.abort();
  }, [enabled, workspaceId]);

  if (!enabled) {
    return null;
  }

  return preview?.workspaceId === workspaceId
    ? preview
    : { workspaceId, status: "loading" };
}

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
  const scratchpadPrivateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(workspace), showPrivateItems);
  const scratchpadPreview = useWorkspaceScratchpadPreview(workspace.id, !scratchpadPrivateHidden);
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
      <Panel data-testid="workspace-activity-card" title="Activity" className="border-0">
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

      <Panel className="border-0">
        <h2 className="mb-3 text-base font-semibold leading-7">
          {scratchpadPrivateHidden ? (
            "Scratchpad"
          ) : (
            <button
              type="button"
              className="cursor-pointer text-left hover:text-blue-600 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:hover:text-blue-400 dark:focus-visible:outline-blue-400"
              onClick={() => onNavigate({ view: "scratchpad", workspaceId: workspace.id })}
            >
              Scratchpad
            </button>
          )}
        </h2>
        <div className="max-h-96 min-h-20 min-w-0 overflow-auto rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-neutral-950">
          {scratchpadPrivateHidden ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Scratchpad content is hidden while private items are hidden.
            </p>
          ) : scratchpadPreview === null || scratchpadPreview.status === "loading" ? (
            <LoadingState title="Loading Scratchpad" />
          ) : scratchpadPreview.status === "error" ? (
            <ErrorState
              title="Unable to load Scratchpad preview"
              description={scratchpadPreview.error}
            />
          ) : scratchpadPreview.content.trim().length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">Scratchpad is empty.</p>
          ) : (
            <MarkdownRenderer content={scratchpadPreview.content} />
          )}
        </div>
      </Panel>

      <ConfiguredAgentsSection
        agents={relatedAgents}
        loading={agentsLoading}
        error={agentsError}
        title="Configured Agents"
        panelClassName="border-0"
        onSelectAgent={(agentId) => onNavigate({ view: "agent", agentId })}
        isAgentPrivateHidden={(agent) => shouldObscurePrivateItem(isEffectivelyPrivate(agent.config, [workspace]), showPrivateItems)}
      />

      {historyTasks.length > 0 || historyChats.length > 0 ? (
        <Panel data-testid="workspace-history-card" title="History" description={historyDescription} className="border-0">
          <div className="space-y-2">
            {historyTasks.map((task) => renderTaskRow(task))}
            {historyChats.map(renderChatRow)}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
