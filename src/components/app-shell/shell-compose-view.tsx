import type {
  ExecutionHostDescriptor,
  Workspace,
  TerminalSession,
} from "@/shared";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import type { CreateTerminalSessionRequest } from "@/contracts";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import type { CreateTaskFormSubmitRequest } from "@/lib/task-request";
import type { CreateTaskFormActionState } from "../CreateTaskForm";
import { TerminalSessionComposer } from "./terminal-session-composer";
import type { UseWorkspaceCreateResult } from "./use-workspace-create";
import { ComposeTaskView } from "./compose-task-view";
import { ComposeChatView } from "./compose-chat-view";
import { ComposeWorkspaceView } from "./compose-workspace-view";
import { AgentComposer } from "./agents-view";
import type { UseAgentsResult } from "../../hooks/useAgents";
import { ExecutionHostChatComposer } from "./execution-host-chat-composer";
import { ExecutionHostTerminalComposer } from "./execution-host-terminal-composer";

type ComposeKind = "task" | "chat" | "agent" | "workspace" | "terminal-session" | "execution-host-chat" | "execution-host-terminal";

export function isComposeKind(value: string): value is ComposeKind {
  return [
    "task",
    "chat",
    "agent",
    "workspace",
    "terminal-session",
    "execution-host-chat",
    "execution-host-terminal",
  ].includes(value);
}

interface ComposeViewProps {
  kind: ComposeKind;
  composeWorkspace: Workspace | null;
  composeExecutionHost: ExecutionHostDescriptor | null;
  navigateWithinShell: (route: WebAppRoute) => void;
  composeActionState: CreateTaskFormActionState | null;
  setComposeActionState: (state: CreateTaskFormActionState | null) => void;
  handleTaskSubmit: (request: CreateTaskFormSubmitRequest) => Promise<boolean>;
  createChat: (request: import("@/contracts").CreateChatRequest) => Promise<import("@/shared").Chat | null>;
  dashboardData: UseDashboardDataResult;
  agents: UseAgentsResult;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceError: string | null;
  workspaceCreate: UseWorkspaceCreateResult;
  createTerminalSession: (request: CreateTerminalSessionRequest) => Promise<TerminalSession>;
  provisioning: UseProvisioningJobResult;
  workspacesSaving: boolean;
}

export function ComposeView(props: ComposeViewProps) {
  const {
    kind,
    composeWorkspace,
    composeExecutionHost,
    navigateWithinShell,
    setComposeActionState,
    handleTaskSubmit,
    createChat,
    dashboardData,
    agents,
    workspaces,
    workspacesLoading,
    workspaceError,
    workspaceCreate,
    createTerminalSession,
    provisioning,
    workspacesSaving,
  } = props;

  if (kind === "task") {
    return (
      <ComposeTaskView
        composeWorkspace={composeWorkspace}
        navigateWithinShell={navigateWithinShell}
        setComposeActionState={setComposeActionState}
        handleTaskSubmit={handleTaskSubmit}
        dashboardData={dashboardData}
        workspaces={workspaces}
        workspacesLoading={workspacesLoading}
        workspaceError={workspaceError}
      />
    );
  }

  if (kind === "workspace") {
    return (
      <ComposeWorkspaceView
        navigateWithinShell={navigateWithinShell}
        workspaceCreate={workspaceCreate}
        provisioning={provisioning}
        workspacesSaving={workspacesSaving}
        dashboardData={dashboardData}
      />
    );
  }

  if (kind === "agent") {
    return (
      <AgentComposer
        composeWorkspace={composeWorkspace}
        workspaces={workspaces}
        workspacesLoading={workspacesLoading}
        workspaceError={workspaceError}
        models={dashboardData.models}
        modelsLoading={dashboardData.modelsLoading}
        modelsWorkspaceId={dashboardData.modelsWorkspaceId}
        lastModel={dashboardData.lastModel}
        branches={dashboardData.branches}
        branchesLoading={dashboardData.branchesLoading}
        branchesWorkspaceId={dashboardData.branchesWorkspaceId}
        currentBranch={dashboardData.currentBranch}
        defaultBranch={dashboardData.defaultBranch}
        onWorkspaceChange={dashboardData.handleWorkspaceChange}
        onCreateAgent={agents.createAgent}
        onPrepareGenerateAgentCode={agents.prepareGenerateAgentCode}
        onGenerateAgentCode={agents.generateAgentCode}
        onTestAgentCode={agents.testAgentCode}
        navigateWithinShell={navigateWithinShell}
      />
    );
  }

  if (kind === "chat") {
    return (
      <ComposeChatView
        composeWorkspace={composeWorkspace}
        workspaces={workspaces}
        workspacesLoading={workspacesLoading}
        workspaceError={workspaceError}
        dashboardData={dashboardData}
        navigateWithinShell={navigateWithinShell}
        createChat={createChat}
      />
    );
  }

  if (kind === "execution-host-chat") {
    return composeExecutionHost ? (
      <ExecutionHostChatComposer
        host={composeExecutionHost}
        navigateWithinShell={navigateWithinShell}
      />
    ) : null;
  }

  if (kind === "execution-host-terminal") {
    return composeExecutionHost ? (
      <ExecutionHostTerminalComposer
        host={composeExecutionHost}
        navigateWithinShell={navigateWithinShell}
        onCreateTerminalSession={createTerminalSession}
      />
    ) : null;
  }

  if (kind === "terminal-session") {
    return (
      <TerminalSessionComposer
        workspaces={workspaces}
        initialWorkspaceId={composeWorkspace?.id}
        onNavigate={navigateWithinShell}
        onCreateTerminalSession={createTerminalSession}
      />
    );
  }

  return null;
}

// Re-export the workspacesSaving prop type for ComposeView (workspace kind needs it)
export type { ComposeViewProps };
