import { describe, expect, mock, test } from "bun:test";
import { CreateEditLoopModal } from "@/components/dashboard-modals";
import { renderWithUser } from "../helpers/render";
import {
  createBranchInfo,
  createLoopWithStatus,
  createModelInfo,
  createWorkspace,
} from "../helpers/factories";

function defaultProps(overrides?: Partial<Parameters<typeof CreateEditLoopModal>[0]>) {
  return {
    loops: [],
    showCreateModal: true,
    editDraftId: null,
    formActionState: null,
    setFormActionState: mock(() => {}),
    onCloseCreateModal: mock(() => {}),
    onCreateLoop: mock(async () => ({ loop: null })),
    onDeleteDraft: mock(async () => true),
    onRefresh: mock(async () => {}),
    models: [createModelInfo()],
    modelsLoading: false,
    lastModel: null,
    lastCheapModel: null,
    setLastModel: mock(() => {}),
    setLastCheapModel: mock(async () => {}),
    onWorkspaceChange: mock(() => {}),
    planningWarning: null,
    branches: [createBranchInfo()],
    branchesLoading: false,
    currentBranch: "main",
    defaultBranch: "main",
    workspaces: [createWorkspace({ id: "ws-1", directory: "/workspaces/project-a" })],
    workspacesLoading: false,
    workspaceError: null,
    setUncommittedModal: mock(() => {}),
    ...overrides,
  };
}

describe("CreateEditLoopModal", () => {
  test("defaults legacy edit drafts with undefined auto-accept to the form default", () => {
    const draftLoop = createLoopWithStatus("draft", {
      config: {
        id: "draft-1",
        name: "Legacy draft",
        workspaceId: "ws-1",
        directory: "/workspaces/project-a",
        prompt: "Do the thing",
        planMode: true,
        autoAcceptPlan: undefined,
      },
    });

    const { getByRole } = renderWithUser(
      <CreateEditLoopModal
        {...defaultProps({
          loops: [draftLoop],
          editDraftId: "draft-1",
        })}
      />
    );

    expect(
      (getByRole("checkbox", { name: /Auto-accept plan/i }) as HTMLInputElement).checked
    ).toBe(true);
  });
});
