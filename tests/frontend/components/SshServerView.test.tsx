import { describe, expect, test } from "bun:test";
import { SshServerView } from "@/components/app-shell/ssh-server-view";
import type { Chat, CreateSshServerChatRequest, SshServer } from "@/types";
import { renderWithUser } from "../helpers/render";

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
  test("submits the selected server default directory after switching servers", async () => {
    const submissions: Array<{ serverId: string; request: CreateSshServerChatRequest }> = [];
    const sidebarPinning = {
      pinnedItems: [],
      isPinned: () => false,
      pinItem: () => {},
      unpinItem: () => {},
      togglePinned: () => {},
    };
    const props = {
      sessions: [],
      chats: [],
      onNavigate: () => {},
      onCreateChat: async (serverId: string, request: CreateSshServerChatRequest): Promise<Chat | null> => {
        submissions.push({ serverId, request });
        return null;
      },
      onOpenSettings: () => {},
      sidebarPinning,
    };

    const { getByRole, getByLabelText, rerender, user } = renderWithUser(
      <SshServerView server={createServer("server-1", "/workspaces/one")} {...props} />,
    );

    await user.click(getByRole("button", { name: "Start chat" }));
    await user.clear(getByLabelText("Remote directory"));
    await user.type(getByLabelText("Remote directory"), "/stale/server-one");

    rerender(<SshServerView server={createServer("server-2", "/workspaces/two")} {...props} />);

    await user.click(getByRole("button", { name: "Start chat" }));
    await user.click(getByRole("button", { name: "Create chat" }));

    expect(submissions).toEqual([{
      serverId: "server-2",
      request: {
        directory: "/workspaces/two",
        model: { providerID: "copilot", modelID: "gpt-5.5", variant: "" },
        autoApprovePermissions: true,
      },
    }]);
  });
});
