import type { Workspace } from "@/shared";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import {
  CreateTaskForm,
} from "../CreateTaskForm";
import type { CreateTaskFormSubmitRequest } from "@/lib/task-request";
import type { WebAppRoute } from "@pablozaiden/webapp/web";

interface ComposeTaskViewProps {
  composeWorkspace: Workspace | null;
  navigateWithinShell: (route: WebAppRoute) => void;
  setComposeActionState: (state: import("../CreateTaskForm").CreateTaskFormActionState | null) => void;
  handleTaskSubmit: (request: CreateTaskFormSubmitRequest) => Promise<boolean>;
  dashboardData: UseDashboardDataResult;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceError: string | null;
}

export function ComposeTaskView(props: ComposeTaskViewProps) {
  const {
    composeWorkspace,
    navigateWithinShell,
    setComposeActionState,
    handleTaskSubmit,
    dashboardData,
    workspaces,
    workspacesLoading,
    workspaceError,
  } = props;

  const handleComposeCancel = () =>
    navigateWithinShell(
      composeWorkspace ? { view: "workspace", workspaceId: composeWorkspace.id } : { view: "home" },
    );

  return (
    <>
      <CreateTaskForm
        key={`task:${composeWorkspace?.id ?? "none"}`}
        onSubmit={handleTaskSubmit}
        onCancel={handleComposeCancel}
        closeOnSuccess={false}
        models={dashboardData.models}
        modelsLoading={dashboardData.modelsLoading}
        lastModel={dashboardData.lastModel}
        lastCheapModel={dashboardData.lastCheapModel}
        onWorkspaceChange={dashboardData.handleWorkspaceChange}
        planningWarning={dashboardData.planningWarning}
        branches={dashboardData.branches}
        branchesLoading={dashboardData.branchesLoading}
        currentBranch={dashboardData.currentBranch}
        defaultBranch={dashboardData.defaultBranch}
        initialTaskData={
          composeWorkspace
            ? {
                directory: composeWorkspace.directory,
                prompt: "",
                workspaceId: composeWorkspace.id,
              }
            : null
        }
        workspaces={workspaces}
        workspacesLoading={workspacesLoading}
        workspaceError={workspaceError}
        renderActions={setComposeActionState}
      />
    </>
  );
}
