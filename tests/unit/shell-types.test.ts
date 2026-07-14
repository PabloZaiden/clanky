import { describe, expect, test } from "bun:test";

import {
  buildActiveWorkSidebarItems,
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

function createChat(): Chat {
  return {
    config: {
      id: "chat-1",
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
      id: "chat-1",
      status: "idle",
      messages: [],
      logs: [],
      toolCalls: [],
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
