import { describe, expect, test } from "bun:test";
import type { Chat } from "@/types";
import { CodeExplorerView } from "@/components/app-shell/code-explorer-view";
import { renderWithUser, waitFor } from "../helpers/render";
import { createTaskWithStatus, createWorkspace } from "../helpers/factories";

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
      scope: overrides?.config?.scope ?? "workspace",
      taskId: overrides?.config?.taskId,
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
    const task = createTaskWithStatus("idle", {
      config: {
        id: "picker-task",
        name: "Picker Task",
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
        tasks={[task]}
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

    expect(optgroups).toEqual(["Workspaces", "Tasks", "Chats"]);
    expect(getByText("Workspaces")).toBeInTheDocument();
    expect(getByText("Tasks")).toBeInTheDocument();
    expect(getByText("Chats")).toBeInTheDocument();
    expect(getByRole("button", { name: /Picker Workspace/i })).toBeInTheDocument();
    expect(getByRole("button", { name: /Picker Task/i })).toBeInTheDocument();
    expect(getByRole("button", { name: /Picker Chat/i })).toBeInTheDocument();
  });

  test("switches content from the generic header dropdown", async () => {
    const workspace = createWorkspace({
      id: "workspace-picker",
      name: "Picker Workspace",
      directory: "/workspaces/picker",
    });
    const task = createTaskWithStatus("idle", {
      config: {
        id: "picker-task",
        name: "Picker Task",
        workspaceId: workspace.id,
        directory: workspace.directory,
      },
    });
    const navigations: unknown[] = [];

    const { getByLabelText, getByRole, user } = renderWithUser(
      <CodeExplorerView
        tasks={[task]}
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

    await user.selectOptions(getByLabelText("Select code explorer content"), "task:picker-task");

    expect(navigations).toEqual([{
      view: "code-explorer",
      target: {
        contentType: "task",
        taskId: "picker-task",
      },
    }]);
  });
});
