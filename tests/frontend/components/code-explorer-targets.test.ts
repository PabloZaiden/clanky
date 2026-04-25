import { describe, expect, test } from "bun:test";
import type { Chat } from "@/types";
import type { SshServer, SshServerSession } from "@/types/ssh-server";
import {
  getChatCodeExplorerRootDirectory,
  getCodeExplorerOptionGroups,
  getCodeExplorerOptions,
  getCodeExplorerTargetId,
  getLoopCodeExplorerRootDirectory,
  resolveCodeExplorerTarget,
} from "@/components/app-shell/code-explorer-targets";
import {
  createLoopWithStatus,
  createSshSession,
  createWorkspace,
} from "../helpers/factories";

function createChat(overrides?: {
  config?: Partial<Chat["config"]>;
  state?: Partial<Chat["state"]>;
}): Chat {
  return {
    config: {
      id: "chat-1",
      name: "Test Chat",
      workspaceId: "workspace-1",
      directory: "/workspaces/project/chat-dir",
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4-20250514",
        variant: "",
      },
      useWorktree: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      mode: "chat",
      ...overrides?.config,
    },
    state: {
      id: "chat-1",
      status: "idle",
      messages: [],
      logs: [],
      toolCalls: [],
      ...overrides?.state,
    },
  };
}

function createSshServer(overrides?: {
  config?: Partial<SshServer["config"]>;
  publicKey?: Partial<SshServer["publicKey"]>;
}): SshServer {
  return {
    config: {
      id: "server-1",
      name: "Build Server",
      address: "server.example",
      username: "tester",
      repositoriesBasePath: "/srv/repos",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides?.config,
    },
    publicKey: {
      algorithm: "RSA-OAEP-256",
      publicKey: "test-public-key",
      fingerprint: "test-fingerprint",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      ...overrides?.publicKey,
    },
  };
}

function createSshServerSession(serverId: string, id = "standalone-1"): SshServerSession {
  return {
    config: {
      id,
      name: "Standalone Session",
      sshServerId: serverId,
      connectionMode: "dtach",
      useTmux: true,
      remoteSessionName: `ralpher-${id}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    state: {
      status: "connected",
    },
  };
}

describe("code explorer target helpers", () => {
  test("derives effective loop and chat root directories from worktrees", () => {
    const loop = createLoopWithStatus("running", {
      config: {
        id: "loop-1",
        directory: "/workspaces/project",
      },
      state: {
        git: {
          originalBranch: "main",
          workingBranch: "feature/code-explorer",
          commits: [],
          worktreePath: "/workspaces/project/.ralph-worktrees/loop-1",
        },
      },
    });
    const chat = createChat({
      state: {
        id: "chat-1",
        status: "idle",
        messages: [],
        logs: [],
        toolCalls: [],
        worktree: {
          originalBranch: "main",
          workingBranch: "chat/code-explorer",
          worktreePath: "/workspaces/project/.ralph-worktrees/chat-1",
        },
      },
    });

    expect(getLoopCodeExplorerRootDirectory(loop)).toBe("/workspaces/project/.ralph-worktrees/loop-1");
    expect(getChatCodeExplorerRootDirectory(chat)).toBe("/workspaces/project/.ralph-worktrees/chat-1");
  });

  test("falls back to configured loop and chat directories when worktrees are missing", () => {
    const loop = createLoopWithStatus("running", {
      config: {
        id: "loop-1",
        directory: "/workspaces/project",
      },
      state: {
        git: {
          originalBranch: "main",
          workingBranch: "feature/code-explorer",
          commits: [],
        },
      },
    });
    const chat = createChat({
      config: {
        directory: "/workspaces/project/chat-dir",
      },
      state: {
        id: "chat-1",
        status: "idle",
        messages: [],
        logs: [],
        toolCalls: [],
      },
    });

    expect(getLoopCodeExplorerRootDirectory(loop)).toBe("/workspaces/project");
    expect(getChatCodeExplorerRootDirectory(chat)).toBe("/workspaces/project/chat-dir");
  });

  test("builds target options across workspaces, loops, servers, and chats", () => {
    const workspace = createWorkspace({
      id: "workspace-1",
      name: "Frontend",
      directory: "/workspaces/frontend",
    });
    const loop = createLoopWithStatus("idle", {
      config: {
        id: "loop-1",
        name: "Lint Loop",
        workspaceId: workspace.id,
        directory: workspace.directory,
      },
    });
    const chat = createChat({
      config: {
        id: "chat-1",
        name: "Review Chat",
        workspaceId: workspace.id,
        directory: `${workspace.directory}/chat`,
      },
    });
    const server = createSshServer();

    const options = getCodeExplorerOptions({
      workspaces: [workspace],
      loops: [loop],
      chats: [chat],
      servers: [server],
    });

    expect(options.map((option) => option.kind)).toEqual(["workspace", "loop", "server", "chat"]);
    expect(options.map((option) => option.label)).toEqual(["Frontend", "Lint Loop", "Build Server", "Review Chat"]);
  });

  test("groups target options by type with stable labels and order", () => {
    const workspace = createWorkspace({
      id: "workspace-1",
      name: "Frontend",
      directory: "/workspaces/frontend",
    });
    const loop = createLoopWithStatus("idle", {
      config: {
        id: "loop-1",
        name: "Lint Loop",
        workspaceId: workspace.id,
        directory: workspace.directory,
      },
    });
    const chat = createChat({
      config: {
        id: "chat-1",
        name: "Review Chat",
        workspaceId: workspace.id,
        directory: `${workspace.directory}/chat`,
      },
    });
    const server = createSshServer();

    const groupedOptions = getCodeExplorerOptionGroups(getCodeExplorerOptions({
      workspaces: [workspace],
      loops: [loop],
      chats: [chat],
      servers: [server],
    }));

    expect(groupedOptions.map((group) => group.label)).toEqual([
      "Workspaces",
      "Loops",
      "SSH servers",
      "Chats",
    ]);
    expect(groupedOptions.map((group) => group.options.map((option) => option.label))).toEqual([
      ["Frontend"],
      ["Lint Loop"],
      ["Build Server"],
      ["Review Chat"],
    ]);
  });

  test("returns stable ids for every code explorer target type", () => {
    expect(getCodeExplorerTargetId({ contentType: "workspace", workspaceId: "workspace-1" })).toBe("workspace-1");
    expect(getCodeExplorerTargetId({ contentType: "loop", loopId: "loop-1" })).toBe("loop-1");
    expect(getCodeExplorerTargetId({ contentType: "server", serverId: "server-1" })).toBe("server-1");
    expect(getCodeExplorerTargetId({ contentType: "chat", chatId: "chat-1" })).toBe("chat-1");
  });

  test("resolves chat targets to workspace-backed code explorer config", () => {
    const workspace = createWorkspace({
      id: "workspace-1",
      name: "Frontend",
      directory: "/workspaces/frontend",
      serverSettings: {
        agent: {
          provider: "opencode",
          transport: "ssh",
          hostname: "remote.example",
          username: "tester",
        },
      },
    });
    const workspaceSession = createSshSession({
      config: {
        id: "session-1",
        workspaceId: workspace.id,
      },
    });
    const chat = createChat({
      config: {
        id: "chat-1",
        name: "Review Chat",
        workspaceId: workspace.id,
        directory: `${workspace.directory}/chat`,
      },
      state: {
        id: "chat-1",
        status: "idle",
        messages: [],
        logs: [],
        toolCalls: [],
        worktree: {
          originalBranch: "main",
          workingBranch: "chat/review",
          worktreePath: `${workspace.directory}/.ralph-worktrees/chat-1`,
        },
      },
    });

    const resolved = resolveCodeExplorerTarget({
      target: { contentType: "chat", chatId: chat.config.id },
      workspaces: [workspace],
      loops: [],
      chats: [chat],
      servers: [],
      sessions: [workspaceSession],
      sessionsByServerId: {},
      createSession: async () => workspaceSession,
      createStandaloneSession: async () => {
        throw new Error("not used");
      },
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.title).toBe("Review Chat code explorer");
    expect(resolved?.backRoute).toEqual({ view: "chat", chatId: chat.config.id });
    expect(resolved?.target).toEqual({
      type: "workspace",
      id: workspace.id,
      startDirectory: `${workspace.directory}/.ralph-worktrees/chat-1`,
    });
    expect(resolved?.sessions).toHaveLength(1);
    expect(resolved?.buildRoute(`${workspace.directory}/.ralph-worktrees/chat-1`)).toEqual({
      view: "code-explorer",
      target: { contentType: "chat", chatId: chat.config.id, startDirectory: undefined },
    });
  });

  test("resolves server targets with standalone ssh session behavior", () => {
    const server = createSshServer();
    const resolved = resolveCodeExplorerTarget({
      target: { contentType: "server", serverId: server.config.id },
      workspaces: [],
      loops: [],
      chats: [],
      servers: [server],
      sessions: [],
      sessionsByServerId: {
        [server.config.id]: [createSshServerSession(server.config.id)],
      },
      createSession: async () => {
        throw new Error("not used");
      },
      createStandaloneSession: async () => createSshServerSession(server.config.id, "standalone-2"),
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.target).toEqual({ type: "server", id: server.config.id, startDirectory: undefined });
    expect(resolved?.credentialPromptName).toBe("Build Server");
    expect(resolved?.sessions).toHaveLength(1);
    expect(resolved?.terminalSelectLabel).toBe("Select standalone SSH session");
  });
});
