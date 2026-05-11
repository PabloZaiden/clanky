import { describe, expect, mock, test } from "bun:test";
import { ComposeChatView } from "@/components/app-shell/compose-chat-view";
import type { UseDashboardDataResult } from "@/hooks/useDashboardData";
import type { Chat, CreateChatRequest } from "@/types";
import { act, renderWithUser, waitFor } from "../helpers/render";
import { createBranchInfo, createModelInfo, createWorkspace } from "../helpers/factories";

const CHAT_MODEL_STORAGE_KEY = "ralpher.chatModelPreference";

function createDashboardData(
  overrides?: Partial<UseDashboardDataResult>,
): UseDashboardDataResult {
  return {
    remoteOnly: false,
    version: "test",
    models: [],
    modelsLoading: false,
    lastModel: null,
    lastCheapModel: null,
    setLastModel: mock(() => {}),
    setLastCheapModel: mock(async () => {}),
    modelsWorkspaceId: null,
    planningWarning: null,
    branches: [],
    branchesLoading: false,
    currentBranch: "",
    defaultBranch: "",
    appSettingsResetting: false,
    appSettingsKilling: false,
    resetAllSettings: mock(async () => false),
    killServer: mock(async () => false),
    handleWorkspaceChange: mock(() => {}),
    resetCreateModalState: mock(() => {}),
    ...overrides,
  };
}

function createChat(overrides?: Partial<Chat>): Chat {
  return {
    config: {
      id: "chat-1",
      name: "Repository pairing session",
      workspaceId: "workspace-1",
      directory: "/workspaces/ralpher",
      model: {
        providerID: "copilot",
        modelID: "gpt-5.4",
        variant: "",
      },
      useWorktree: true,
      autoApprovePermissions: true,
      baseBranch: "main",
      createdAt: "2026-04-21T00:00:00.000Z",
      updatedAt: "2026-04-21T00:00:00.000Z",
      mode: "chat",
      scope: "workspace",
    },
    state: {
      id: "chat-1",
      status: "idle",
      messages: [],
      logs: [],
      toolCalls: [],
      pendingPermissionRequests: [],
    },
    ...overrides,
  };
}

describe("ComposeChatView", () => {
  test("loads workspace data only once for equivalent rerenders", async () => {
    const workspace = createWorkspace({
      id: "workspace-1",
      name: "Ralpher",
      directory: "/workspaces/ralpher",
    });
    const handleWorkspaceChange = mock(() => {});
    const resetCreateModalState = mock(() => {});

    const { rerender } = renderWithUser(
      <ComposeChatView
        composeWorkspace={workspace}
        workspaces={[workspace]}
        workspacesLoading={false}
        workspaceError={null}
        dashboardData={createDashboardData({
          handleWorkspaceChange,
          resetCreateModalState,
        })}
        shellHeaderOffsetClassName=""
        navigateWithinShell={mock(() => {})}
        createChat={mock(async () => null)}
      />,
    );

    await waitFor(() => {
      expect(handleWorkspaceChange).toHaveBeenCalledTimes(1);
    });

    rerender(
      <ComposeChatView
        composeWorkspace={workspace}
        workspaces={[workspace]}
        workspacesLoading={false}
        workspaceError={null}
        dashboardData={createDashboardData({
          handleWorkspaceChange,
          resetCreateModalState,
        })}
        shellHeaderOffsetClassName=""
        navigateWithinShell={mock(() => {})}
        createChat={mock(async () => null)}
      />,
    );

    expect(handleWorkspaceChange).toHaveBeenCalledTimes(1);
    expect(resetCreateModalState).not.toHaveBeenCalled();
  });

  test("preserves a user-selected branch across steady-state rerenders", async () => {
    const workspace = createWorkspace({
      id: "workspace-1",
      directory: "/workspaces/ralpher",
    });
    const handleWorkspaceChange = mock(() => {});
    const resetCreateModalState = mock(() => {});
    const models = [
      createModelInfo({
        providerID: "copilot",
        providerName: "Copilot",
        modelID: "gpt-5.4",
        modelName: "GPT-5.4",
        connected: true,
      }),
    ];
    const branches = [
      createBranchInfo({ name: "main", current: false }),
      createBranchInfo({ name: "develop", current: true }),
    ];

    const { getByLabelText, rerender, user } = renderWithUser(
      <ComposeChatView
        composeWorkspace={workspace}
        workspaces={[workspace]}
        workspacesLoading={false}
        workspaceError={null}
        dashboardData={createDashboardData({
          handleWorkspaceChange,
          models,
          resetCreateModalState,
          branches,
          defaultBranch: "main",
          currentBranch: "develop",
        })}
        shellHeaderOffsetClassName=""
        navigateWithinShell={mock(() => {})}
        createChat={mock(async () => null)}
      />,
    );

    const branchSelect = getByLabelText("Base Branch") as HTMLSelectElement;

    await waitFor(() => {
      expect(branchSelect.value).toBe("main");
    });

    await user.selectOptions(branchSelect, "develop");

    await waitFor(() => {
      expect(branchSelect.value).toBe("develop");
    });

    await act(async () => {
      rerender(
        <ComposeChatView
          composeWorkspace={workspace}
          workspaces={[workspace]}
          workspacesLoading={false}
        workspaceError={null}
        dashboardData={createDashboardData({
          handleWorkspaceChange,
          models,
          resetCreateModalState,
          branches,
          defaultBranch: "main",
          currentBranch: "develop",
          })}
          shellHeaderOffsetClassName=""
          navigateWithinShell={mock(() => {})}
          createChat={mock(async () => null)}
        />,
      );
    });

    await waitFor(() => {
      expect((getByLabelText("Base Branch") as HTMLSelectElement).value).toBe("develop");
    });
  });

  test("keeps chat creation disabled while workspace data is still loading", async () => {
    const workspace = createWorkspace({
      id: "workspace-1",
      directory: "/workspaces/ralpher",
    });
    const { getByLabelText, getByRole, user } = renderWithUser(
      <ComposeChatView
        composeWorkspace={workspace}
        workspaces={[workspace]}
        workspacesLoading={false}
        workspaceError={null}
        dashboardData={createDashboardData({
          models: [
            createModelInfo({
              providerID: "copilot",
              providerName: "Copilot",
              modelID: "gpt-5.4",
              modelName: "GPT-5.4",
              connected: true,
            }),
          ],
          branches: [createBranchInfo({ name: "main", current: true })],
          branchesLoading: true,
          defaultBranch: "main",
          currentBranch: "main",
        })}
        shellHeaderOffsetClassName=""
        navigateWithinShell={mock(() => {})}
        createChat={mock(async () => null)}
      />,
    );

    await user.type(getByLabelText("Name"), "Repository pairing session");

    await waitFor(() => {
      expect(getByRole("button", { name: "Create chat" })).toBeDisabled();
    });
  });

  test("prefers the locally stored chat model over the dashboard fallback", async () => {
    window.localStorage.setItem(
      CHAT_MODEL_STORAGE_KEY,
      JSON.stringify({
        providerID: "copilot",
        modelID: "gpt-5.4",
        variant: "standard",
      }),
    );
    const workspace = createWorkspace({
      id: "workspace-1",
      directory: "/workspaces/ralpher",
    });
    const models = [
      createModelInfo({
        providerID: "copilot",
        providerName: "Copilot",
        modelID: "gpt-5.4",
        modelName: "GPT-5.4",
        connected: true,
        variants: ["fast", "standard"],
      }),
      createModelInfo({
        providerID: "openai",
        providerName: "OpenAI",
        modelID: "gpt-4o",
        modelName: "GPT-4o",
        connected: true,
      }),
    ];

    const { getByLabelText } = renderWithUser(
      <ComposeChatView
        composeWorkspace={workspace}
        workspaces={[workspace]}
        workspacesLoading={false}
        workspaceError={null}
        dashboardData={createDashboardData({
          models,
          lastModel: { providerID: "openai", modelID: "gpt-4o", variant: "" },
          handleWorkspaceChange: mock(() => {}),
          resetCreateModalState: mock(() => {}),
        })}
        shellHeaderOffsetClassName=""
        navigateWithinShell={mock(() => {})}
        createChat={mock(async () => null)}
      />,
    );

    await waitFor(() => {
      expect((getByLabelText("Model") as HTMLSelectElement).value).toBe(
        "copilot:gpt-5.4:standard",
      );
    });
  });

  test("falls back to the dashboard last model when the stored chat model is unavailable", async () => {
    window.localStorage.setItem(
      CHAT_MODEL_STORAGE_KEY,
      JSON.stringify({
        providerID: "missing-provider",
        modelID: "missing-model",
        variant: "",
      }),
    );
    const workspace = createWorkspace({
      id: "workspace-1",
      directory: "/workspaces/ralpher",
    });
    const models = [
      createModelInfo({
        providerID: "copilot",
        providerName: "Copilot",
        modelID: "gpt-5.4",
        modelName: "GPT-5.4",
        connected: true,
      }),
    ];

    const { getByLabelText } = renderWithUser(
      <ComposeChatView
        composeWorkspace={workspace}
        workspaces={[workspace]}
        workspacesLoading={false}
        workspaceError={null}
        dashboardData={createDashboardData({
          models,
          lastModel: { providerID: "copilot", modelID: "gpt-5.4", variant: "" },
          handleWorkspaceChange: mock(() => {}),
          resetCreateModalState: mock(() => {}),
        })}
        shellHeaderOffsetClassName=""
        navigateWithinShell={mock(() => {})}
        createChat={mock(async () => null)}
      />,
    );

    await waitFor(() => {
      expect((getByLabelText("Model") as HTMLSelectElement).value).toBe(
        "copilot:gpt-5.4:",
      );
    });
  });

  test("persists the selected chat model locally after a successful creation", async () => {
    const workspace = createWorkspace({
      id: "workspace-1",
      directory: "/workspaces/ralpher",
    });
    const setLastModel = mock(() => {});
    const createChatRequest = mock(async (_request: CreateChatRequest) => createChat());
    const navigateWithinShell = mock(() => {});

    const { getByLabelText, getByRole, user } = renderWithUser(
      <ComposeChatView
        composeWorkspace={workspace}
        workspaces={[workspace]}
        workspacesLoading={false}
        workspaceError={null}
        dashboardData={createDashboardData({
          models: [
            createModelInfo({
              providerID: "copilot",
              providerName: "Copilot",
              modelID: "gpt-5.4",
              modelName: "GPT-5.4",
              connected: true,
              variants: ["fast", "standard"],
            }),
          ],
          branches: [createBranchInfo({ name: "main", current: true })],
          defaultBranch: "main",
          currentBranch: "main",
          setLastModel,
        })}
        shellHeaderOffsetClassName=""
        navigateWithinShell={navigateWithinShell}
        createChat={createChatRequest}
      />,
    );

    await user.type(getByLabelText("Name"), "Repository pairing session");
    await user.selectOptions(getByLabelText("Model"), "copilot:gpt-5.4:standard");
    await user.click(getByRole("button", { name: "Create chat" }));

    await waitFor(() => {
      expect(createChatRequest).toHaveBeenCalledTimes(1);
    });
    expect(createChatRequest.mock.calls[0]?.[0]).toMatchObject({
      autoApprovePermissions: true,
    });

    expect(window.localStorage.getItem(CHAT_MODEL_STORAGE_KEY)).toBe(
      JSON.stringify({
        providerID: "copilot",
        modelID: "gpt-5.4",
        variant: "standard",
      }),
    );
    expect(setLastModel).toHaveBeenCalledWith({
      providerID: "copilot",
      modelID: "gpt-5.4",
      variant: "standard",
    });
    expect(navigateWithinShell).toHaveBeenCalledWith({
      view: "chat",
      chatId: "chat-1",
    });
  });

  test("submits chat creation without a name so the API can generate one", async () => {
    const workspace = createWorkspace({
      id: "workspace-1",
      directory: "/workspaces/ralpher",
    });
    const createChatRequest = mock(async (_request: CreateChatRequest) => createChat({
      config: {
        ...createChat().config,
        name: "Ralpher - 1",
      },
    }));

    const { getByLabelText, getByRole, user } = renderWithUser(
      <ComposeChatView
        composeWorkspace={workspace}
        workspaces={[workspace]}
        workspacesLoading={false}
        workspaceError={null}
        dashboardData={createDashboardData({
          models: [
            createModelInfo({
              providerID: "copilot",
              providerName: "Copilot",
              modelID: "gpt-5.4",
              modelName: "GPT-5.4",
              connected: true,
            }),
          ],
          branches: [createBranchInfo({ name: "main", current: true })],
          defaultBranch: "main",
          currentBranch: "main",
        })}
        shellHeaderOffsetClassName=""
        navigateWithinShell={mock(() => {})}
        createChat={createChatRequest}
      />,
    );

    await user.selectOptions(getByLabelText("Model"), "copilot:gpt-5.4:");
    await user.click(getByRole("button", { name: "Create chat" }));

    await waitFor(() => {
      expect(createChatRequest).toHaveBeenCalledTimes(1);
    });
    expect(createChatRequest.mock.calls[0]?.[0]).toMatchObject({
      name: "",
      workspaceId: "workspace-1",
    });
  });

  test("submits disabled auto-approval when the checkbox is unchecked", async () => {
    const workspace = createWorkspace({
      id: "workspace-1",
      directory: "/workspaces/ralpher",
    });
    const createChatRequest = mock(async (_request: CreateChatRequest) => createChat());

    const { getByLabelText, getByRole, user } = renderWithUser(
      <ComposeChatView
        composeWorkspace={workspace}
        workspaces={[workspace]}
        workspacesLoading={false}
        workspaceError={null}
        dashboardData={createDashboardData({
          models: [
            createModelInfo({
              providerID: "copilot",
              providerName: "Copilot",
              modelID: "gpt-5.4",
              modelName: "GPT-5.4",
              connected: true,
            }),
          ],
          branches: [createBranchInfo({ name: "main", current: true })],
          defaultBranch: "main",
          currentBranch: "main",
        })}
        shellHeaderOffsetClassName=""
        navigateWithinShell={mock(() => {})}
        createChat={createChatRequest}
      />,
    );

    await user.type(getByLabelText("Name"), "Repository pairing session");
    await user.click(getByRole("checkbox", { name: /auto-approve permissions/i }));
    await user.click(getByRole("button", { name: "Create chat" }));

    await waitFor(() => {
      expect(createChatRequest).toHaveBeenCalledTimes(1);
    });
    expect(createChatRequest.mock.calls[0]?.[0]).toMatchObject({
      autoApprovePermissions: false,
    });
  });
});
