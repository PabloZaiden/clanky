import { describe, expect, test } from "bun:test";
import { SshSessionComposer } from "@/components/app-shell/ssh-session-composer";
import { createSshSession, createWorkspace } from "../helpers/factories";
import { renderWithUser, waitFor } from "../helpers/render";
import type { SshServer } from "@/types";

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

describe("SshSessionComposer", () => {
  test("sends the tmux preference for workspace sessions", async () => {
    const workspace = createWorkspace({ id: "workspace-1", name: "SSH Workspace" });
    let receivedRequest: Record<string, unknown> | null = null;
    const { getByRole, user } = renderWithUser(
      <SshSessionComposer
        workspaces={[workspace]}
        servers={[]}
        onCancel={() => {}}
        onNavigate={() => {}}
        onCreateWorkspaceSession={async (request) => {
          receivedRequest = request;
          return createSshSession({ config: { id: "ssh-session-1", workspaceId: request.workspaceId } });
        }}
        onCreateStandaloneSession={async () => {
          throw new Error("unexpected standalone create");
        }}
      />,
    );

    expect(getByRole("checkbox", { name: /Start in tmux when available/i })).not.toBeChecked();
    await user.click(getByRole("button", { name: "Create SSH Session" }));

    await waitFor(() => {
      expect(receivedRequest).toEqual({
        workspaceId: "workspace-1",
        name: "SSH session",
        connectionMode: "dtach",
        useTmux: false,
      });
    });
  });

  test("sends the tmux preference for standalone server sessions", async () => {
    const server = createServer();
    let receivedServerId: string | null = null;
    let receivedOptions: Record<string, unknown> | null = null;
    const { getByLabelText, getByRole, user } = renderWithUser(
      <SshSessionComposer
        workspaces={[]}
        servers={[server]}
        onCancel={() => {}}
        onNavigate={() => {}}
        onCreateWorkspaceSession={async () => {
          throw new Error("unexpected workspace create");
        }}
        onCreateStandaloneSession={async (serverId, options) => {
          receivedServerId = serverId;
          receivedOptions = options as Record<string, unknown>;
          return {
            config: {
              id: "standalone-session-1",
              sshServerId: serverId,
              name: options?.name ?? "SSH session",
              connectionMode: options?.connectionMode ?? "dtach",
              useTmux: options?.useTmux ?? true,
              remoteSessionName: "ralpher-standalone-1",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            state: {
              status: "ready",
            },
          };
        }}
      />,
    );

    expect(getByRole("checkbox", { name: /Start in tmux when available/i })).not.toBeChecked();
    await user.selectOptions(getByLabelText("Target type"), "server");
    await user.click(getByRole("button", { name: "Create SSH Session" }));

    await waitFor(() => {
      expect(receivedServerId).toBe("server-1");
      expect(receivedOptions).toEqual({
        name: "SSH session",
        connectionMode: "dtach",
        useTmux: false,
      });
    });
  });
});
