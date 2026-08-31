import { describe, expect, test } from "bun:test";
import type { Agent, AgentRun, SshServerSession, Workspace } from "@/shared";
import { getDefaultServerSettings } from "@/shared/settings";
import type { SidebarNode, SidebarNodeSnapshot, WebAppRoute } from "@pablozaiden/webapp/web";
import {
  buildShellSidebarComposition,
  type ShellSidebarActionHandlers,
  type ShellSidebarCompositionOptions,
} from "../../src/components/app-shell/shell-sidebar-composition";
import type { SidebarWorkspaceGroupNode } from "../../src/components/app-shell/shell-types";

const sidebarHandlers = {
  route: { view: "home" },
  selectedChat: null,
  selectedChatActions: [],
  navigateWithinShell: (_route: WebAppRoute) => undefined,
  onError: (_message: string) => undefined,
  toggleTaskPrivate: () => undefined,
  toggleChatPrivate: () => undefined,
  markChatDone: () => undefined,
  toggleAgentPrivate: () => undefined,
  toggleWorkspacePrivate: () => undefined,
  toggleSshServerPrivate: () => undefined,
  toggleStandaloneSshSessionPrivate: (
    _serverId: string,
    _session: SshServerSession,
  ) => undefined,
  stopSidebarTask: () => undefined,
  openRenameStandaloneSshSession: () => undefined,
  openDeleteStandaloneSshSession: () => undefined,
  toggleTerminalSessionPrivate: () => undefined,
  openRenameTerminalSession: () => undefined,
  openDeleteTerminalSession: () => undefined,
  pullLatestWorkspaceChanges: () => undefined,
  pullingLatestWorkspaceIds: new Set<string>(),
  toggleWorkspaceArchived: () => undefined,
  archivingWorkspaceIds: new Set<string>(),
  setEditingAgentId: (_agentId: string) => undefined,
  setDeleteAgentTarget: () => undefined,
  setPurgeAgentTarget: () => undefined,
  agents: {
    pauseAgent: async (_agentId: string): Promise<Agent | null> => null,
    resumeAgent: async (_agentId: string): Promise<Agent | null> => null,
    interruptAgent: async (_agentId: string): Promise<AgentRun | null> => null,
    runAgent: async (_agentId: string): Promise<AgentRun | null> => null,
  },
  showPrivateItems: false,
} satisfies ShellSidebarActionHandlers;

function createWorkspace(): Workspace {
  return {
    id: "workspace-1",
    name: "Workspace One",
    directory: "/workspaces/one",
    workspaceType: "git",
    serverSettings: getDefaultServerSettings(),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createWorkspaceGroup(workspace: Workspace): SidebarWorkspaceGroupNode {
  return {
    key: "all",
    title: "All workspaces",
    workspaces: [{
      workspace,
      key: workspace.id,
      tasks: [],
      historyTasks: [],
      chats: [],
      historyChats: [],
      terminalSessions: [],
      hasActivity: false,
    }],
  };
}

function createOptions(
  sidebarSnapshotReady: boolean,
  sidebarWorkspaceGroups: SidebarWorkspaceGroupNode[] = [],
): ShellSidebarCompositionOptions {
  return {
    sidebarWorkspaceGroups,
    serverNodes: [],
    workspaces: sidebarWorkspaceGroups.flatMap((group) => group.workspaces.map((node) => node.workspace)),
    agents: [],
    handlers: sidebarHandlers,
    sidebarSnapshotReady,
    quickChatUnavailableReason: null,
    quickChatCreating: false,
    onQuickChat: () => undefined,
  };
}

function getWorkspaceSnapshot(
  sidebarSnapshotReady: boolean,
  sidebarWorkspaceGroups: SidebarWorkspaceGroupNode[] = [],
): SidebarNodeSnapshot {
  const composition = buildShellSidebarComposition(createOptions(sidebarSnapshotReady, sidebarWorkspaceGroups));
  const snapshot = composition.sidebar.getNodes({
    search: "",
    activeTab: "workspaces",
  });
  if (Array.isArray(snapshot)) {
    throw new Error("Expected sidebar.getNodes to return a snapshot object");
  }
  return snapshot;
}

function hasPinId(nodes: readonly SidebarNode[], pinId: string): boolean {
  return nodes.some((node) => node.pinId === pinId
    || (node.children ? hasPinId(node.children, pinId) : false));
}

describe("shell sidebar composition", () => {
  test("reports snapshot readiness without changing the selected nodes", () => {
    const notReady = getWorkspaceSnapshot(false);
    const ready = getWorkspaceSnapshot(true);

    expect(notReady.ready).toBe(false);
    expect(ready.ready).toBe(true);
    expect(ready.nodes.map((node) => node.id)).toEqual(notReady.nodes.map((node) => node.id));
  });

  test("keeps a deleted persisted pin out of a ready snapshot", () => {
    const workspace = createWorkspace();
    const beforeDelete = getWorkspaceSnapshot(true, [createWorkspaceGroup(workspace)]);
    const persistedPinId = `workspace:${workspace.id}`;
    const pinnedSidebarIds = new Set([persistedPinId]);
    const afterDelete = getWorkspaceSnapshot(true);

    expect(hasPinId(beforeDelete.nodes, persistedPinId)).toBe(true);
    expect(afterDelete.ready).toBe(true);
    expect([...pinnedSidebarIds].some((pinId) => hasPinId(afterDelete.nodes, pinId))).toBe(false);
  });
});
