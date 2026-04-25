import { describe, expect, test } from "bun:test";
import type { Chat } from "@/types";
import { CodeExplorerView } from "@/components/app-shell/code-explorer-view";
import { renderWithUser, waitFor } from "../helpers/render";
import { createLoopWithStatus, createWorkspace } from "../helpers/factories";

function createChat(overrides?: {
  config?: Partial<Chat["config"]>;
  state?: Partial<Chat["state"]>;
}): Chat {
  return {
    config: {
      id: "chat-1",
      name: "Picker Chat",
      workspaceId: "workspace-picker",
      directory: "/workspaces/picker/chat",
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

describe("CodeExplorerView", () => {
  test("renders grouped dropdown options and grouped selection sections", async () => {
    const workspace = createWorkspace({
      id: "workspace-picker",
      name: "Picker Workspace",
      directory: "/workspaces/picker",
    });
    const loop = createLoopWithStatus("idle", {
      config: {
        id: "picker-loop",
        name: "Picker Loop",
        workspaceId: workspace.id,
        directory: workspace.directory,
      },
    });
    const chat = createChat({
      config: {
        id: "picker-chat",
        workspaceId: workspace.id,
        directory: `${workspace.directory}/chat`,
      },
      state: {
        id: "picker-chat",
      },
    });

    const { getByLabelText, getByRole, getByText } = renderWithUser(
      <CodeExplorerView
        loops={[loop]}
        chats={[chat]}
        workspaces={[workspace]}
        sessions={[]}
        servers={[]}
        sessionsByServerId={{}}
        createSession={async () => {
          throw new Error("not used");
        }}
        createStandaloneSession={async () => {
          throw new Error("not used");
        }}
        onNavigate={() => {}}
      />,
    );

    await waitFor(() => {
      expect(getByRole("heading", { name: "Code explorer" })).toBeInTheDocument();
    });

    const select = getByLabelText("Select code explorer content") as HTMLSelectElement;
    const optgroups = Array.from(select.querySelectorAll("optgroup")).map((group) => group.label);

    expect(optgroups).toEqual(["Workspaces", "Loops", "Chats"]);
    expect(getByText("Workspaces")).toBeInTheDocument();
    expect(getByText("Loops")).toBeInTheDocument();
    expect(getByText("Chats")).toBeInTheDocument();
    expect(getByRole("button", { name: /Picker Workspace/i })).toBeInTheDocument();
    expect(getByRole("button", { name: /Picker Loop/i })).toBeInTheDocument();
    expect(getByRole("button", { name: /Picker Chat/i })).toBeInTheDocument();
  });

  test("switches content from the generic header dropdown", async () => {
    const workspace = createWorkspace({
      id: "workspace-picker",
      name: "Picker Workspace",
      directory: "/workspaces/picker",
    });
    const loop = createLoopWithStatus("idle", {
      config: {
        id: "picker-loop",
        name: "Picker Loop",
        workspaceId: workspace.id,
        directory: workspace.directory,
      },
    });
    const navigations: unknown[] = [];

    const { getByLabelText, getByRole, user } = renderWithUser(
      <CodeExplorerView
        loops={[loop]}
        chats={[]}
        workspaces={[workspace]}
        sessions={[]}
        servers={[]}
        sessionsByServerId={{}}
        createSession={async () => {
          throw new Error("not used");
        }}
        createStandaloneSession={async () => {
          throw new Error("not used");
        }}
        onNavigate={(route) => {
          navigations.push(route);
        }}
      />,
    );

    await waitFor(() => {
      expect(getByRole("heading", { name: "Code explorer" })).toBeInTheDocument();
    });

    await user.selectOptions(getByLabelText("Select code explorer content"), "loop:picker-loop");

    expect(navigations).toEqual([{
      view: "code-explorer",
      target: {
        contentType: "loop",
        loopId: "picker-loop",
      },
    }]);
  });
});
