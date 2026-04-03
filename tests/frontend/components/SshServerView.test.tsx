import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderWithUser } from "../helpers/render";
import { SshServerView } from "@/components/app-shell/ssh-server-view";
import type { SshServer, SshServerSession } from "@/types";

function createServer(): SshServer {
  return {
    config: {
      id: "server-1",
      name: "Build Box",
      address: "10.0.0.5",
      username: "vscode",
      repositoriesBasePath: "/workspaces",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    publicKey: {
      algorithm: "RSA-OAEP-256",
      publicKey: "public-key",
      fingerprint: "fingerprint",
      version: 1,
      createdAt: new Date().toISOString(),
    },
  };
}

function createSession(): SshServerSession {
  return {
    config: {
      id: "standalone-session-1",
      sshServerId: "server-1",
      name: "Deploy Shell",
      connectionMode: "dtach",
      remoteSessionName: "ralpher-standalone-1",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    state: {
      status: "ready",
    },
  };
}

describe("SshServerView", () => {
  const onNavigate = mock((_route: unknown) => {});
  const onOpenSettings = mock(() => {});

  beforeEach(() => {
    onNavigate.mockClear();
    onOpenSettings.mockClear();
  });

  test("opens the SSH server settings route from the detail view", async () => {
    const { getByRole, user } = renderWithUser(
      <SshServerView
        server={createServer()}
        sessions={[createSession()]}
        onNavigate={onNavigate}
        onOpenSettings={onOpenSettings}
      />,
    );

    await user.click(getByRole("button", { name: "Open SSH server settings" }));

    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  test("groups editor and session actions in the action menu", async () => {
    const { getByRole, user } = renderWithUser(
      <SshServerView
        server={createServer()}
        sessions={[createSession()]}
        onNavigate={onNavigate}
        onOpenSettings={onOpenSettings}
      />,
    );

    await user.click(getByRole("button", { name: "SSH server actions for Build Box" }));
    await user.click(getByRole("menuitem", { name: "Open Editor" }));
    expect(onNavigate).toHaveBeenCalledWith({ view: "server-files", serverId: "server-1" });
  });
});
