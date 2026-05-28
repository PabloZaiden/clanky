import { describe, expect, mock, test } from "bun:test";
import { SshServerView } from "@/components/app-shell/ssh-server-view";
import type { SshServer } from "@/types";
import { renderWithUser } from "../helpers/render";

mock.module("@/hooks/sshServerActions", () => ({
  listSshServersApi: async () => [],
  getSshServerApi: async () => createServer("server-1", "/workspaces/one"),
  listSshServerSessionsApi: async () => [],
  createSshServerApi: async () => createServer("server-1", "/workspaces/one"),
  updateSshServerApi: async () => createServer("server-1", "/workspaces/one"),
  deleteSshServerApi: async () => true,
  createStandaloneSshSessionApi: async () => ({
    config: {
      id: "standalone-session-1",
      sshServerId: "server-1",
      name: "Standalone session",
      connectionMode: "dtach",
      useTmux: true,
      remoteSessionName: "clanky-standalone-session-1",
      createdAt: "2026-05-28T00:00:00.000Z",
      updatedAt: "2026-05-28T00:00:00.000Z",
    },
    state: { status: "ready" },
  }),
  deleteStandaloneSshSessionApi: async () => true,
  saveStandaloneSshServerPassword: async () => true,
  checkSshServerPrerequisitesApi: async () => ({
    serverId: "server-1",
    checkedAt: "2026-05-28T00:00:00.000Z",
    summary: {
      status: "ready",
      availableCount: 0,
      missingCount: 0,
      notApplicableCount: 0,
      unknownCount: 0,
    },
    checks: [],
  }),
  listDevboxTemplatesApi: async () => [
    {
      name: "python",
      description: "Python 3.14 on Debian bookworm.",
      source: "built-in",
      base: "bookworm",
      image: "mcr.microsoft.com/devcontainers/python:3.0.7-3.14-bookworm",
      pinnedReference: "mcr.microsoft.com/devcontainers/python:3.0.7-3.14-bookworm",
      runtimeVersion: "Python 3.14",
      languages: ["python"],
      runnerCompatible: true,
    },
  ],
  listVncSessionsApi: async () => [],
  createOrResumeVncSessionApi: async () => {
    throw new Error("not implemented in this test");
  },
  closeVncSessionApi: async () => true,
}));

function createServer(id: string, repositoriesBasePath: string | null): SshServer {
  return {
    config: {
      id,
      name: `Server ${id}`,
      address: `${id}.example.com`,
      username: "deploy",
      repositoriesBasePath,
      createdAt: "2026-04-28T00:00:00.000Z",
      updatedAt: "2026-04-28T00:00:00.000Z",
    },
    publicKey: {
      algorithm: "RSA-OAEP-256",
      publicKey: "test-public-key",
      fingerprint: "test-fingerprint",
      version: 1,
      createdAt: "2026-04-28T00:00:00.000Z",
    },
  };
}

describe("SshServerView", () => {
  test("keeps chat creation out of the SSH server detail page", () => {
    const sidebarPinning = {
      pinnedItems: [],
      isPinned: () => false,
      pinItem: () => {},
      unpinItem: () => {},
      togglePinned: () => {},
    };

    const { queryByRole, queryByText } = renderWithUser(
      <SshServerView
        server={createServer("server-1", "/workspaces/one")}
        sessions={[]}
        onNavigate={() => {}}
        onOpenSettings={() => {}}
        sidebarPinning={sidebarPinning}
      />,
    );

    expect(queryByRole("button", { name: "Start chat" })).toBeNull();
    expect(queryByText("Remote chats")).toBeNull();
  });

  test("exposes VNC connection from the server action menu", async () => {
    const sidebarPinning = {
      pinnedItems: [],
      isPinned: () => false,
      pinItem: () => {},
      unpinItem: () => {},
      togglePinned: () => {},
    };

    const { user, getByRole } = renderWithUser(
      <SshServerView
        server={createServer("server-1", "/workspaces/one")}
        sessions={[]}
        onNavigate={() => {}}
        onOpenSettings={() => {}}
        sidebarPinning={sidebarPinning}
      />,
    );

    await user.click(getByRole("button", { name: /SSH server actions/ }));
    expect(getByRole("menuitem", { name: "Start VNC Session" })).toBeTruthy();
  });
});
