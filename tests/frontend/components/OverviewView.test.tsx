import { describe, expect, test } from "bun:test";
import { renderWithUser } from "../helpers/render";
import { createChat, createWorkspace } from "../helpers/factories";
import { OverviewView } from "@/components/app-shell/overview-view";
import { buildServerSidebarNodes, buildWorkspaceSidebarGroups } from "@/components/app-shell/shell-types";
import { groupTasksByStatus } from "@/hooks/useTaskGrouping";
import type { SshServer } from "@/types";
import type { ShellRoute } from "@/components/app-shell/shell-types";

function createServer(overrides?: Partial<SshServer["config"]>): SshServer {
  const now = new Date().toISOString();
  return {
    config: {
      id: "server-1",
      name: "Shared host",
      address: "ssh.example.com",
      username: "deploy",
      repositoriesBasePath: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    },
    publicKey: {
      algorithm: "RSA-OAEP-256",
      publicKey: "-----BEGIN PUBLIC KEY-----\nTEST\n-----END PUBLIC KEY-----",
      fingerprint: "fp-1",
      version: 1,
      createdAt: now,
    },
  };
}

describe("OverviewView", () => {
  test("shows existing quick chats and opens the selected chat", async () => {
    const workspace = createWorkspace({ id: "workspace-1", name: "Quick Workspace" });
    const activeQuickChat = createChat({
      config: { id: "chat-active", name: "Active quick chat", workspaceId: workspace.id },
      state: { status: "streaming" },
    });
    const idleQuickChat = createChat({
      config: { id: "chat-idle", name: "Idle quick chat", workspaceId: workspace.id },
      state: { status: "idle" },
    });
    const sidebarWorkspaceGroups = buildWorkspaceSidebarGroups({
      workspaces: [workspace],
      tasks: [],
      chats: [activeQuickChat, idleQuickChat],
      sessions: [],
    });
    const quickChatWorkspace = sidebarWorkspaceGroups
      .flatMap((group) => group.workspaces)
      .find((node) => node.workspace.id === workspace.id)!;
    const navigatedRoutes: ShellRoute[] = [];

    const { getByRole, user } = renderWithUser(
      <OverviewView
        servers={[]}
        sessionsByServerId={{}}
        serverNodes={[]}
        workspaceGroups={[{ workspace, tasks: [], statusGroups: groupTasksByStatus([]) }]}
        sidebarWorkspaceGroups={sidebarWorkspaceGroups}
        quickChatWorkspace={quickChatWorkspace}
        onNavigate={(route) => navigatedRoutes.push(route)}
      />,
    );

    expect(getByRole("heading", { name: "Quick Chats" })).toBeTruthy();
    expect(getByRole("button", { name: /Active quick chat/ })).toBeTruthy();
    expect(getByRole("button", { name: /Idle quick chat/ })).toBeTruthy();

    await user.click(getByRole("button", { name: /Idle quick chat/ }));

    expect(navigatedRoutes).toEqual([{ view: "chat", chatId: "chat-idle" }]);
  });

  test("renders workspaces before servers", () => {
    const workspace = createWorkspace({ id: "workspace-1", name: "Project Workspace" });
    const server = createServer();
    const serverNodes = buildServerSidebarNodes({
      servers: [server],
      sessionsByServerId: {},
      workspaces: [workspace],
      workspaceSessions: [],
    });

    const { getByRole } = renderWithUser(
      <OverviewView
        servers={[server]}
        sessionsByServerId={{}}
        serverNodes={serverNodes}
        workspaceGroups={[{ workspace, tasks: [], statusGroups: groupTasksByStatus([]) }]}
        sidebarWorkspaceGroups={buildWorkspaceSidebarGroups({
          workspaces: [workspace],
          tasks: [],
          chats: [],
          sessions: [],
        })}
        quickChatWorkspace={null}
        onNavigate={() => {}}
      />,
    );

    const workspacesHeading = getByRole("heading", { name: "Workspaces" });
    const serversHeading = getByRole("heading", { name: "Servers" });

    expect(
      workspacesHeading.compareDocumentPosition(serversHeading) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
