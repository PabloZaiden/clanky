import { describe, expect, test } from "bun:test";

import {
  buildActiveWorkSidebarItems,
  buildChatHistorySidebarItems,
  buildServerSidebarNodes,
  buildWorkspaceSidebarGroups,
} from "../../src/components/app-shell/shell-types";
import type { Chat } from "@/shared/chat";
import type { SshServer, SshServerSession } from "@/shared/ssh-server";
import type { SshSession } from "@/shared/ssh-session";
import { getDefaultServerSettings } from "@/shared/settings";
import type { Workspace } from "@/shared/workspace";

const BASE_TIMESTAMP = "2026-01-01T00:00:00.000Z";

function createWorkspace(): Workspace {
  return {
    id: "workspace-1",
    name: "Workspace One",
    directory: "/workspaces/one",
    serverSettings: getDefaultServerSettings(),
    createdAt: BASE_TIMESTAMP,
    updatedAt: BASE_TIMESTAMP,
    sshServerId: "server-1",
  };
}

function createSshServer(): SshServer {
  return {
    config: {
      id: "server-1",
      name: "Server One",
      address: "example.com",
      username: "dev",
      repositoriesBasePath: null,
      createdAt: BASE_TIMESTAMP,
      updatedAt: BASE_TIMESTAMP,
    },
    publicKey: {
      algorithm: "RSA-OAEP-256",
      publicKey: "public-key",
      fingerprint: "fingerprint",
      version: 1,
      createdAt: BASE_TIMESTAMP,
    },
  };
}

function createWorkspaceSession(): SshSession {
  return {
    config: {
      id: "workspace-session-1",
      name: "Workspace Session",
      workspaceId: "workspace-1",
      directory: "/workspaces/one",
      connectionMode: "dtach",
      useTmux: false,
      remoteSessionName: "workspace-session",
      createdAt: BASE_TIMESTAMP,
      updatedAt: BASE_TIMESTAMP,
    },
    state: {
      status: "ready",
    },
  };
}

function createServerSession(): SshServerSession {
  return {
    config: {
      id: "server-session-1",
      name: "Server Session",
      sshServerId: "server-1",
      connectionMode: "dtach",
      useTmux: false,
      remoteSessionName: "server-session",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    },
    state: {
      status: "ready",
    },
  };
}

function createChat(status: Chat["state"]["status"] = "idle", id = "chat-1"): Chat {
  return {
    config: {
      id,
      name: "Quick Chat",
      workspaceId: "workspace-1",
      scope: "workspace",
      directory: "/workspaces/one",
      model: {
        providerID: "copilot",
        modelID: "gpt-5.5",
        variant: "",
      },
      useWorktree: true,
      createdAt: BASE_TIMESTAMP,
      updatedAt: BASE_TIMESTAMP,
      mode: "chat",
    },
    state: {
      id,
      status,
      messages: [],
      logs: [],
      toolCalls: [],
    },
  };
}

function createServerChat(status: Chat["state"]["status"], id: string): Chat {
  const chat = createChat(status, id);
  return {
    ...chat,
    config: {
      ...chat.config,
      workspaceId: "",
      source: {
        kind: "ssh_server",
        sshServerId: "server-1",
        sshServerSessionId: "server-session-1",
        directory: "/remote/workspace",
      },
      directory: "/remote/workspace",
    },
  };
}

function createAgentChat(): Chat {
  const chat = createChat();
  return {
    ...chat,
    config: {
      ...chat.config,
      id: "agent-chat-1",
      name: "Generate code",
      scope: "agent",
    },
  };
}

describe("sidebar node builders", () => {
  test("keeps workspace SSH sessions out of SSH server session nodes", () => {
    const workspaceSession = createWorkspaceSession();
    const serverSession = createServerSession();
    const workspaceGroups = buildWorkspaceSidebarGroups({
      workspaces: [createWorkspace()],
      tasks: [],
      chats: [],
      sessions: [workspaceSession],
    });
    const serverNodes = buildServerSidebarNodes({
      servers: [createSshServer()],
      sessionsByServerId: {
        "server-1": [serverSession],
      },
      chats: [],
    });

    const workspaceNode = workspaceGroups[0]!.workspaces[0]!;
    const serverNode = serverNodes[0]!;

    expect(workspaceNode.sshSessions.map((sessionNode) => sessionNode.session.config.id)).toEqual([
      "workspace-session-1",
    ]);
    expect(serverNode.sessions.map((sessionNode) => sessionNode.id)).toEqual([
      "server-session-1",
    ]);
    expect(serverNode.sessions.some((sessionNode) => sessionNode.id === "workspace-session-1")).toBe(false);

    expect(buildActiveWorkSidebarItems(workspaceGroups, { serverNodes }).map((item) => item.key)).toEqual([
      "ssh-session:workspace-session-1",
      "ssh-server-session:server-session-1",
    ]);
  });

  test("includes quick chats in active work", () => {
    const quickChat = createChat();
    const workspaceGroups = buildWorkspaceSidebarGroups({
      workspaces: [createWorkspace()],
      tasks: [],
      chats: [quickChat],
      sessions: [],
    });
    expect(buildActiveWorkSidebarItems(workspaceGroups).map((item) => item.key)).toEqual([
      "chat:chat-1",
    ]);
  });

  test("moves done workspace and SSH-server chats into history", () => {
    const activeWorkspaceChat = createChat("idle", "workspace-active");
    const doneWorkspaceChat = createChat("done", "workspace-done");
    const activeServerChat = createServerChat("idle", "server-active");
    const doneServerChat = createServerChat("done", "server-done");
    const workspaceGroups = buildWorkspaceSidebarGroups({
      workspaces: [createWorkspace()],
      tasks: [],
      chats: [activeWorkspaceChat, doneWorkspaceChat],
      sessions: [],
    });
    const serverNodes = buildServerSidebarNodes({
      servers: [createSshServer()],
      sessionsByServerId: {},
      chats: [activeServerChat, doneServerChat],
    });

    const workspaceNode = workspaceGroups[0]!.workspaces[0]!;
    expect(workspaceNode.chats.map((chatNode) => chatNode.chat.config.id)).toEqual(["workspace-active"]);
    expect(workspaceNode.historyChats.map((chatNode) => chatNode.chat.config.id)).toEqual(["workspace-done"]);
    expect(buildActiveWorkSidebarItems(workspaceGroups, { serverNodes }).map((item) => item.key)).toEqual([
      "chat:workspace-active",
      "ssh-server-chat:server-active",
    ]);
    expect(buildChatHistorySidebarItems(workspaceGroups, { serverNodes }).map((item) => item.key)).toEqual([
      "chat:workspace-done",
      "ssh-server-chat:server-done",
    ]);
  });

  test("keeps deterministic-agent chats out of sidebar nodes", () => {
    const workspaceGroups = buildWorkspaceSidebarGroups({
      workspaces: [createWorkspace()],
      tasks: [],
      chats: [createChat(), createAgentChat()],
      sessions: [],
    });

    const workspaceNode = workspaceGroups[0]!.workspaces[0]!;
    expect(workspaceNode.chats.map((chatNode) => chatNode.chat.config.id)).toEqual(["chat-1"]);
  });

  test("excludes archived workspace activity from active work", () => {
    const archivedWorkspace = {
      ...createWorkspace(),
      archived: true,
    };
    const workspaceGroups = buildWorkspaceSidebarGroups({
      workspaces: [archivedWorkspace],
      tasks: [],
      chats: [createChat()],
      sessions: [createWorkspaceSession()],
    });

    expect(buildActiveWorkSidebarItems(workspaceGroups).map((item) => item.key)).toEqual([]);
  });
});
