import { describe, expect, test } from "bun:test";
import {
  buildActiveWorkSidebarItems,
  type SidebarExecutionHostNode,
  type SidebarExecutionHostTerminalNode,
  type SidebarWorkspaceGroupNode,
} from "../../src/components/app-shell/shell-types";
import {
  DEFAULT_CHAT_CONFIG,
  createInitialChatState,
  type Chat,
  type ExecutionHostBinding,
  type ExecutionHostDescriptor,
  type Task,
  type TerminalSession,
  type Workspace,
} from "../../src/shared";
import { DEFAULT_TASK_CONFIG, createInitialState } from "../../src/shared/task";

const binding: ExecutionHostBinding = {
  host: { kind: "local", nodeId: "local" },
  targetKey: "local",
  revision: 1,
};

const workspace: Workspace = {
  id: "workspace-1",
  name: "Workspace",
  directory: "/workspace",
  scratchpad: "",
  workspaceType: "git",
  executionTargetRevision: 1,
  executionHostBinding: binding,
  serverSettings: {
    agent: {
      adapter: "acp",
      provider: "opencode",
    },
  },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const host: ExecutionHostDescriptor = {
  ref: { kind: "local", nodeId: "local" },
  targetKey: "local",
  name: "Local host",
  endpoint: null,
  meshRouteKind: null,
  repositoriesBasePath: null,
  preferredModel: null,
  configurationRevision: 1,
  accessRequirement: { kind: "none" },
  acceptRemoteExecution: true,
  platform: null,
  capabilities: {},
  harnessAdapters: [],
  revision: 1,
};

function createTask(
  id: string,
  createdAt: string,
  lastUserMessageAt?: string,
): Task {
  return {
    config: {
      ...DEFAULT_TASK_CONFIG,
      id,
      name: id,
      directory: workspace.directory,
      prompt: id,
      workspaceId: workspace.id,
      model: {
        providerID: "opencode",
        modelID: "test-model",
        variant: "",
      },
      createdAt,
      updatedAt: createdAt,
    },
    state: {
      ...createInitialState(id),
      lastUserMessageAt,
    },
  };
}

function createChat(
  id: string,
  createdAt: string,
  lastUserMessageAt?: string,
): Chat {
  return {
    config: {
      ...DEFAULT_CHAT_CONFIG,
      id,
      name: id,
      workspaceId: workspace.id,
      directory: workspace.directory,
      model: {
        providerID: "opencode",
        modelID: "test-model",
        variant: "",
      },
      createdAt,
      updatedAt: createdAt,
    },
    state: {
      ...createInitialChatState(id),
      lastUserMessageAt,
    },
  };
}

function createTerminalSession(
  id: string,
  createdAt: string,
  lastConnectedAt?: string,
): TerminalSession {
  return {
    config: {
      id,
      name: id,
      workspaceId: workspace.id,
      directory: workspace.directory,
      connectionMode: "direct",
      useTmux: false,
      remoteSessionName: id,
      executionHostBinding: binding,
      createdAt,
      updatedAt: createdAt,
    },
    state: { status: "ready", lastConnectedAt },
  };
}

function createSidebarGroups(): SidebarWorkspaceGroupNode[] {
  const task = createTask(
    "task-old-message",
    "2026-01-20T00:00:00.000Z",
    "2026-01-02T00:00:00.000Z",
  );
  const workspaceChat = createChat(
    "workspace-chat",
    "2026-01-01T00:00:00.000Z",
    "2026-01-04T00:00:00.000Z",
  );
  const terminal = createTerminalSession(
    "workspace-terminal",
    "2026-01-05T00:00:00.000Z",
  );
  const connectedTerminal = createTerminalSession(
    "workspace-terminal-connected",
    "2026-01-03T00:00:00.000Z",
    "2026-01-09T00:00:00.000Z",
  );

  return [{
    key: "all",
    title: "Workspaces",
    workspaces: [{
      workspace,
      key: workspace.id,
      tasks: [{
        task,
        title: task.config.name,
        badge: "Running",
        badgeVariant: "info",
      }],
      historyTasks: [],
      chats: [{
        chat: workspaceChat,
        title: workspaceChat.config.name,
        badge: "Idle",
        badgeVariant: "default",
      }],
      historyChats: [],
      terminalSessions: [terminal, connectedTerminal].map((session) => ({
        session,
        title: session.config.name,
        subtitle: "Direct",
        badge: "Ready",
        badgeVariant: "success" as const,
        createdAt: session.config.createdAt,
      })),
      hasActivity: true,
    }],
  }];
}

function createExecutionHostNodes(): SidebarExecutionHostNode[] {
  const hostChat = createChat(
    "host-chat-fallback",
    "2026-01-05T00:00:00.000Z",
  );
  const fallbackTerminal = createTerminalSession(
    "host-terminal-fallback",
    "2026-01-06T00:00:00.000Z",
  );
  const connectedTerminal = createTerminalSession(
    "host-terminal-connected",
    "2026-01-02T00:00:00.000Z",
    "2026-01-08T00:00:00.000Z",
  );
  const terminalSessions: SidebarExecutionHostTerminalNode[] = [fallbackTerminal, connectedTerminal].map((session) => ({
    session,
    title: session.config.name,
    subtitle: "Direct",
    badge: "Ready",
    badgeVariant: "success",
    createdAt: session.config.createdAt,
  }));
  return [{
    host,
    key: host.targetKey,
    terminalSessions,
    chats: [{
      chat: hostChat,
      title: hostChat.config.name,
      badge: "Idle",
      badgeVariant: "default",
    }],
    historyChats: [],
  }];
}

describe("Active Work ordering", () => {
  // Regression: heterogeneous Active Work entries must share one deterministic
  // user-activity ordering; terminal connections supersede their creation time.
  test("sorts tasks, chats, and terminal sessions by effective user activity", () => {
    const items = buildActiveWorkSidebarItems(createSidebarGroups(), {
      executionHostNodes: createExecutionHostNodes(),
    });

    expect(items.map((item) => item.key)).toEqual([
      "terminal-session:workspace-terminal-connected",
      "execution-host-terminal:host-terminal-connected",
      "execution-host-terminal:host-terminal-fallback",
      "execution-host-chat:host-chat-fallback",
      "terminal-session:workspace-terminal",
      "chat:workspace-chat",
      "task:task-old-message",
    ]);
  });
});
