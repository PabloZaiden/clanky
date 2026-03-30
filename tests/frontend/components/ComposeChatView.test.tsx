import { describe, expect, mock, test } from "bun:test";
import { ComposeChatView } from "@/components/app-shell/compose-chat-view";
import type { UseDashboardDataResult } from "@/hooks/useDashboardData";
import { act, renderWithUser, waitFor } from "../helpers/render";
import { createBranchInfo, createModelInfo, createWorkspace } from "../helpers/factories";

function createDashboardData(
  overrides?: Partial<UseDashboardDataResult>,
): UseDashboardDataResult {
  return {
    remoteOnly: false,
    version: "test",
    models: [],
    modelsLoading: false,
    lastModel: null,
    setLastModel: mock(() => {}),
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
});
