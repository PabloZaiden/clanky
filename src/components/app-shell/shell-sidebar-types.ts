import type { ActionMenuItem, SidebarNode, WebAppRoute, SidebarAction as FrameworkSidebarAction } from "@pablozaiden/webapp/web";
import type { WebAppRootProps } from "@/platform/web/root-types";
import type { ReactNode } from "react";
import type { UseChatTrashResult } from "../../hooks/useChatTrash";
import type { ChatTrashActions } from "./use-chat-trash-actions";
import type {
  Agent,
  Chat,
  ExecutionHostDescriptor,
  Task,
  TerminalSession,
  Workspace,
} from "@/shared";
import type { UseAgentsResult } from "../../hooks/useAgents";
import type { NotificationSettings } from "../../hooks/useNotificationSettings";
import type { PrivateSidebarNode } from "../../lib/private-items";
import type {
  SidebarExecutionHostNode,
  SidebarWorkspaceGroupNode,
} from "./shell-types";

export type TerminalSessionActionTarget = { id: string; name: string };

export type SidebarAction = (...args: never[]) => void | Promise<void>;

export type SearchableSidebarNode = PrivateSidebarNode & {
  searchText?: string;
};

export interface ShellSidebarActionHandlers {
  route: WebAppRoute;
  selectedChat: Chat | null;
  selectedChatActions: ActionMenuItem[];
  navigateWithinShell: (route: WebAppRoute) => void;
  openHarnessActivity: (route: WebAppRoute) => void;
  onError: (message: string) => void;
  toggleTaskPrivate: (task: Task) => void | Promise<void>;
  toggleChatPrivate: (chat: Chat) => void | Promise<void>;
  getChatLifecycleActions: (chat: Chat) => ActionMenuItem[];
  toggleAgentPrivate: (agent: Agent) => void | Promise<void>;
  stopSidebarTask: (task: Task) => void | Promise<void>;
  toggleTerminalSessionPrivate: (session: TerminalSession) => void | Promise<void>;
  openRenameTerminalSession: (target: TerminalSessionActionTarget) => void;
  openDeleteTerminalSession: (target: TerminalSessionActionTarget) => void;
  setEditingAgentId: (agentId: string) => void;
  setDeleteAgentTarget: (agent: Agent) => void;
  setPurgeAgentTarget: (agent: Agent) => void;
  exportAgent: (agent: Agent) => void | Promise<void>;
  agents: Pick<UseAgentsResult, "pauseAgent" | "resumeAgent" | "interruptAgent" | "runAgent">;
  showPrivateItems: boolean;
}

export interface ShellSidebarCompositionOptions {
  trash: UseChatTrashResult;
  trashActions: ChatTrashActions;
  sidebarWorkspaceGroups: SidebarWorkspaceGroupNode[];
  executionHostNodes: SidebarExecutionHostNode[];
  executionHosts: ExecutionHostDescriptor[];
  remoteOnly: boolean;
  chats: Chat[];
  terminalSessions: TerminalSession[];
  workspaces: Workspace[];
  agents: Agent[];
  handlers: ShellSidebarActionHandlers;
  sidebarSnapshotReady: boolean;
  quickChatUnavailableReason: string | null;
  quickChatCreating: boolean;
  onQuickChat: () => void;
  notificationSettings: NotificationSettings | null;
  voiceActions: FrameworkSidebarAction[];
  voiceControls: ReactNode;
}

export interface ShellSidebarComposition {
  sidebar: NonNullable<WebAppRootProps["sidebar"]>;
  headerNodes: SidebarNode[];
}

export type SidebarTabId = "active" | "workspaces" | "servers";
