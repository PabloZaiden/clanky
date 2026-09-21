import type {
  ActionMenuItem,
  SidebarNode,
  WebAppRootProps,
  WebAppRoute,
} from "@pablozaiden/webapp/web";
import type {
  Agent,
  Chat,
  ExecutionHostDescriptor,
  SshServer,
  Task,
  TerminalSession,
  Workspace,
} from "@/shared";
import type { UseAgentsResult } from "../../hooks/useAgents";
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
  onError: (message: string) => void;
  toggleTaskPrivate: (task: Task) => void | Promise<void>;
  toggleChatPrivate: (chat: Chat) => void | Promise<void>;
  markChatDone: (chat: Chat) => void | Promise<void>;
  toggleAgentPrivate: (agent: Agent) => void | Promise<void>;
  toggleWorkspacePrivate: (workspace: Workspace) => void | Promise<void>;
  toggleSshServerPrivate: (server: SshServer) => void | Promise<void>;
  stopSidebarTask: (task: Task) => void | Promise<void>;
  toggleTerminalSessionPrivate: (session: TerminalSession) => void | Promise<void>;
  openRenameTerminalSession: (target: TerminalSessionActionTarget) => void;
  openDeleteTerminalSession: (target: TerminalSessionActionTarget) => void;
  pullLatestWorkspaceChanges: (workspaceId: string) => void | Promise<void>;
  pullingLatestWorkspaceIds: ReadonlySet<string>;
  toggleWorkspaceArchived: (workspace: Workspace) => void | Promise<void>;
  archivingWorkspaceIds: ReadonlySet<string>;
  setEditingAgentId: (agentId: string) => void;
  setDeleteAgentTarget: (agent: Agent) => void;
  setPurgeAgentTarget: (agent: Agent) => void;
  exportAgent: (agent: Agent) => void | Promise<void>;
  startAgentImport: (workspaceId: string) => void;
  agents: Pick<UseAgentsResult, "pauseAgent" | "resumeAgent" | "interruptAgent" | "runAgent">;
  showPrivateItems: boolean;
}

export interface ShellSidebarCompositionOptions {
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
}

export interface ShellSidebarComposition {
  sidebar: NonNullable<WebAppRootProps["sidebar"]>;
  headerNodes: SidebarNode[];
}

export type SidebarTabId = "active" | "workspaces" | "servers";
