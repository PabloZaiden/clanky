import type {
  ExecutionHostDescriptor,
  Workspace,
  TerminalSession,
} from "@/shared";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import type { CreateTerminalSessionRequest } from "@/contracts";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import { TerminalSessionComposer } from "./terminal-session-composer";
import type { UseWorkspaceCreateResult } from "./use-workspace-create";
import { ComposeChatView } from "./compose-chat-view";
import { ComposeWorkspaceView } from "./compose-workspace-view";
import { AutomationComposer } from "./automations-view";
import type { UseAutomationsResult } from "../../hooks/useAutomations";
import type { UseChatsResult } from "../../hooks/useChats";
import { ExecutionHostChatComposer } from "./execution-host-chat-composer";
import { ExecutionHostTerminalComposer } from "./execution-host-terminal-composer";

type ComposeKind = "chat" | "automation" | "workspace" | "terminal-session" | "execution-host-chat" | "execution-host-terminal";

export function isComposeKind(value: string): value is ComposeKind {
  return [
    "chat",
    "automation",
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
  createChat: (request: import("@/contracts").CreateChatRequest) => Promise<import("@/shared").Chat | null>;
  createExecutionHostChat: UseChatsResult["createExecutionHostChat"];
  startAutomationImport: (workspaceId: string) => void;
  dashboardData: UseDashboardDataResult;
  automations: UseAutomationsResult;
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
    createChat,
    createExecutionHostChat,
    dashboardData,
    automations,
    workspaces,
    workspacesLoading,
    workspaceError,
    workspaceCreate,
    createTerminalSession,
    provisioning,
    workspacesSaving,
  } = props;

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

  if (kind === "automation") {
    return (
      <AutomationComposer
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
        onCreateAutomation={automations.createAutomation}
        onImportAutomation={props.startAutomationImport}
        onPrepareGenerateAutomationCode={automations.prepareGenerateAutomationCode}
        onGenerateAutomationCode={automations.generateAutomationCode}
        onTestAutomationCode={automations.testAutomationCode}
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
        onCreateChat={createExecutionHostChat}
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
