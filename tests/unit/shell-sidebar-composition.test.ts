import { describe, expect, test } from "bun:test";
import type { Agent, AgentRun, SshServerSession } from "@/shared";
import type { SidebarNodeSnapshot, WebAppRoute } from "@pablozaiden/webapp/web";
import {
  buildShellSidebarComposition,
  type ShellSidebarActionHandlers,
  type ShellSidebarCompositionOptions,
} from "../../src/components/app-shell/shell-sidebar-composition";

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
  toggleWorkspaceSshSessionPrivate: () => undefined,
  toggleSshServerPrivate: () => undefined,
  toggleStandaloneSshSessionPrivate: (
    _serverId: string,
    _session: SshServerSession,
  ) => undefined,
  stopSidebarTask: () => undefined,
  openRenameSshSession: () => undefined,
  openDeleteSshSession: () => undefined,
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

function createOptions(sidebarSnapshotReady: boolean): ShellSidebarCompositionOptions {
  return {
    sidebarWorkspaceGroups: [],
    serverNodes: [],
    workspaces: [],
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
): SidebarNodeSnapshot {
  const composition = buildShellSidebarComposition(createOptions(sidebarSnapshotReady));
  const snapshot = composition.sidebar.getNodes({
    search: "",
    activeTab: "workspaces",
  });
  if (Array.isArray(snapshot)) {
    throw new Error("Expected a ready sidebar snapshot");
  }
  return snapshot;
}

describe("shell sidebar composition", () => {
  test("reports snapshot readiness without changing the selected nodes", () => {
    const notReady = getWorkspaceSnapshot(false);
    const ready = getWorkspaceSnapshot(true);

    expect(notReady.ready).toBe(false);
    expect(ready.ready).toBe(true);
    expect(ready.nodes.map((node) => node.id)).toEqual(notReady.nodes.map((node) => node.id));
  });
});
