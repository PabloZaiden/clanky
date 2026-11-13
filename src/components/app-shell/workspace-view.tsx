import { useEffect, useState } from "react";
import type { Automation, Chat, PublicWorkspace, Workspace } from "@/shared";
import type { useChats } from "../../hooks";
import type { UseTerminalSessionsResult } from "../../hooks/useTerminalSessions";
import {
  StatusBadge,
  Button,
  StateText,
  getChatStatusBadgeVariant,
  formatStatusLabel,
  getTerminalSessionStatusBadgeVariant,
  getTerminalSessionStatusLabel,
} from "../common";
import { EmptyState, ErrorState, LoadingState, Panel, type WebAppRoute } from "@pablozaiden/webapp/web";
import { ConfiguredAutomationsSection } from "../ConfiguredAutomationsSection";
import {
  isEffectivelyPrivate,
  shouldObscurePrivateItem,
} from "../../lib/private-items";
import { WorkItemRow } from "./work-item-row";
import { apiRequest } from "../../lib/api-client";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { normalizeGitHubRepositoryUrl } from "../../lib/github-repository-url";
import { isWorkspaceReadOnly } from "@/shared/workspace";

async function openWorkspaceGitHubUrl(
  workspace: Workspace,
  onError: (message: string) => void,
): Promise<void> {
  const persistedUrl = normalizeGitHubRepositoryUrl(workspace.repoUrl ?? "");
  if (persistedUrl) {
    window.open(persistedUrl, "_blank", "noopener,noreferrer");
    return;
  }

  let fetchedUrl: string | null;
  try {
    const data = await apiRequest<{ githubUrl?: unknown }>(
      `/api/git/github-repository-url?workspaceId=${encodeURIComponent(workspace.id)}`,
      {
        action: "Load GitHub repository URL",
        fallbackMessage: "GitHub repository URL is not available for this workspace",
      },
    );
    fetchedUrl = typeof data.githubUrl === "string"
      ? normalizeGitHubRepositoryUrl(data.githubUrl)
      : null;
  } catch (error) {
    onError(String(error));
    return;
  }

  if (!fetchedUrl) {
    onError("GitHub repository URL is not available for this workspace");
    return;
  }

  window.open(fetchedUrl, "_blank", "noopener,noreferrer");
}

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
  relatedChats,
  relatedTerminalSessions,
  relatedAutomations,
  automationsLoading,
  automationsError,
  onNavigate,
  onPullLatestChanges,
  pullingLatestChanges,
  onError,
  showPrivateItems = false,
}: {
  workspace: Workspace;
  relatedChats: ReturnType<typeof useChats>["chats"];
  relatedTerminalSessions: UseTerminalSessionsResult["sessions"];
  relatedAutomations: Automation[];
  automationsLoading: boolean;
  automationsError: string | null;
  onNavigate: (route: WebAppRoute) => void;
  onPullLatestChanges: () => Promise<void>;
  pullingLatestChanges: boolean;
  onError: (message: string) => void;
  showPrivateItems?: boolean;
}) {
  const scratchpadPrivateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(workspace), showPrivateItems);
  const scratchpadPreview = useWorkspaceScratchpadPreview(workspace.id, !scratchpadPrivateHidden);
  const activityChats = relatedChats.filter((chat) => chat.state.status !== "done");
  const historyChats = relatedChats.filter((chat) => chat.state.status === "done");
  const hasActivity = activityChats.length > 0 || relatedTerminalSessions.length > 0;
  const historyDescription = "Chats marked as done.";

  function renderChatRow(chat: Chat) {
    const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(chat.config, [workspace]), showPrivateItems);
    return (
      <WorkItemRow
        key={chat.config.id}
        title={chat.config.name}
        workspace={workspace}
        itemType="Chat"
        lastInteractionAt={chat.state.lastUserMessageAt ?? chat.config.createdAt}
        badge={<StatusBadge variant={getChatStatusBadgeVariant(chat.state.status)}><StateText>{formatStatusLabel(chat.state.status)}</StateText></StatusBadge>}
        onClick={() => onNavigate({ view: "chat", chatId: chat.config.id })}
        privateHidden={privateHidden}
      />
    );
  }

  return (
    <div className="min-w-0 space-y-6">
      {workspace.workspaceType === "git" && !scratchpadPrivateHidden ? (
        <div className="flex flex-wrap justify-end gap-2">
          {!isWorkspaceReadOnly(workspace) ? (
            <Button
              onClick={() => void onPullLatestChanges()}
              loading={pullingLatestChanges}
            >
              {pullingLatestChanges ? "Pulling Latest Changes..." : "Pull Latest Changes"}
            </Button>
          ) : null}
          <Button onClick={() => void openWorkspaceGitHubUrl(workspace, onError)}>
            Open in GitHub
          </Button>
        </div>
      ) : null}
      <Panel data-testid="workspace-activity-card" title="Activity" className="border-0">
        <div>
          {hasActivity ? (
            <div className="space-y-2">
              {activityChats.map(renderChatRow)}
              {relatedTerminalSessions.map((terminal) => {
                const privateHidden = shouldObscurePrivateItem(isEffectivelyPrivate(terminal.config, [workspace]), showPrivateItems);
                return (
                  <WorkItemRow
                    key={terminal.config.id}
                    title={terminal.config.name}
                    workspace={workspace}
                    itemType="Terminal"
                    lastInteractionAt={terminal.state.lastConnectedAt ?? terminal.config.createdAt}
                    badge={<StatusBadge variant={getTerminalSessionStatusBadgeVariant(terminal.state.status)}>{getTerminalSessionStatusLabel(terminal.state.status)}</StatusBadge>}
                    onClick={() => onNavigate({ view: "terminal", terminalSessionId: terminal.config.id })}
                    privateHidden={privateHidden}
                  />
                );
              })}
            </div>
          ) : (
            <EmptyState title="No active items" description="There are no active chats or sessions in this workspace right now." />
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

      <ConfiguredAutomationsSection
        automations={relatedAutomations}
        loading={automationsLoading}
        error={automationsError}
        title="Configured Automations"
        panelClassName="border-0"
        onSelectAutomation={(automationId) => onNavigate({ view: "automation", automationId })}
        isAutomationPrivateHidden={(automation) => shouldObscurePrivateItem(isEffectivelyPrivate(automation.config, [workspace]), showPrivateItems)}
      />

      {historyChats.length > 0 ? (
        <Panel data-testid="workspace-history-card" title="History" description={historyDescription} className="border-0">
          <div className="space-y-2">
            {historyChats.map(renderChatRow)}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
