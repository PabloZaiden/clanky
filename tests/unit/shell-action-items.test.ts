import { describe, expect, test } from "bun:test";
import {
  buildChatActionItems,
  buildSshServerActionItems,
  buildSshSessionActionItems,
  buildTaskActionItems,
  buildWorkspaceActionItems,
} from "../../src/components/app-shell/shell-action-items";
import type { Chat, SshServer, Workspace } from "../../src/types";
import type { SidebarPinningState } from "../../src/components/app-shell/sidebar-pins";

function labels(items: { label: string }[]): string[] {
  return items.map((item) => item.label);
}

function createPinningState(pinned = false): SidebarPinningState {
  return {
    pinnedItems: [],
    isPinned: () => pinned,
    pinItem: () => {},
    unpinItem: () => {},
    togglePinned: () => {},
  };
}

function createWorkspace(transport: "stdio" | "ssh" = "ssh"): Workspace {
  return {
    id: "workspace-1",
    name: "Workspace",
    serverSettings: {
      agent: { transport },
    },
  } as Workspace;
}

function createServer(): SshServer {
  return {
    config: {
      id: "server-1",
      name: "Server",
    },
  } as SshServer;
}

function createChat(overrides: Partial<Chat["state"]> = {}): Chat {
  return {
    config: {
      id: "chat-1",
      name: "Chat",
    },
    state: {
      status: "idle",
      messages: [{ role: "user", content: "hello" }],
      ...overrides,
    },
  } as Chat;
}

describe("shell action item builders", () => {
  test("workspace builder includes the complete shared workspace action list", () => {
    const items = buildWorkspaceActionItems({
      workspace: createWorkspace("ssh"),
      githubUrl: "https://github.com/example/repo",
      pullingLatestChanges: false,
      onNavigate: () => {},
      onPullLatestChanges: () => {},
      onOpenGitHub: () => {},
      sidebarPinning: createPinningState(),
    });

    expect(labels(items)).toEqual([
      "New Task",
      "New Chat",
      "Open code explorer",
      "Pull Latest Changes",
      "Open in GitHub",
      "New SSH Session",
      "Workspace Settings",
      "Pin to sidebar",
    ]);
  });

  test("ssh server builder includes VNC, settings, and pin actions", () => {
    const items = buildSshServerActionItems({
      server: createServer(),
      onNavigate: () => {},
      sidebarPinning: createPinningState(true),
    });

    expect(labels(items)).toEqual([
      "Open code explorer",
      "New Session",
      "New Chat",
      "Start VNC Session",
      "SSH Server Settings",
      "Unpin from sidebar",
    ]);
  });

  test("task builder includes code explorer and pin actions", () => {
    const items = buildTaskActionItems({
      taskId: "task-1",
      onOpenCodeExplorer: () => {},
      sidebarPinning: createPinningState(),
    });

    expect(labels(items)).toEqual(["Open code explorer", "Pin to sidebar"]);
  });

  test("chat builder preserves pending disabled state and destructive delete", () => {
    const items = buildChatActionItems({
      chat: createChat({ status: "streaming" }),
      hasCodeExplorerAction: true,
      spawnPending: false,
      spawnCurrentPlanPending: false,
      onSpawnTask: () => {},
      onSpawnTaskFromCurrentPlan: () => {},
      onOpenCodeExplorer: () => {},
      onRename: () => {},
      onDelete: () => {},
      sidebarPinning: createPinningState(),
    });

    expect(labels(items)).toEqual([
      "Spawn Task",
      "Spawn task from plan file",
      "Code explorer",
      "Rename",
      "Pin to sidebar",
      "Delete",
    ]);
    expect(items.find((item) => item.id === "spawn-task")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "delete")?.destructive).toBe(true);
  });

  test("chat builder labels only the active spawn action as pending", () => {
    const items = buildChatActionItems({
      chat: createChat(),
      hasCodeExplorerAction: true,
      spawnPending: false,
      spawnCurrentPlanPending: true,
      onSpawnTask: () => {},
      onSpawnTaskFromCurrentPlan: () => {},
      onOpenCodeExplorer: () => {},
      onRename: () => {},
      onDelete: () => {},
    });

    expect(labels(items).slice(0, 2)).toEqual(["Spawn Task", "Spawning task from plan file..."]);
    expect(items.find((item) => item.id === "spawn-task")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "spawn-task-from-current-plan")?.disabled).toBe(true);
  });

  test("ssh session builder includes open, rename, delete, and pin actions", () => {
    const items = buildSshSessionActionItems({
      sessionId: "session-1",
      canRename: false,
      onOpenSession: () => {},
      onRename: () => {},
      onDelete: () => {},
      sidebarPinning: createPinningState(),
    });

    expect(labels(items)).toEqual(["Open session", "Rename", "Pin to sidebar", "Delete"]);
    expect(items.find((item) => item.id === "rename")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "delete")?.destructive).toBe(true);
  });

  test("ssh session builder can omit open session action for current-session menus", () => {
    const items = buildSshSessionActionItems({
      sessionId: "session-1",
      includeOpenSession: false,
      canRename: true,
      onOpenSession: () => {},
      onRename: () => {},
      onDelete: () => {},
      sidebarPinning: createPinningState(),
    });

    expect(labels(items)).toEqual(["Rename", "Pin to sidebar", "Delete"]);
  });
});
