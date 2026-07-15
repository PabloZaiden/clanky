import type { SshSession, SshConnectionMode, Workspace } from "@/shared";
import type { WebAppRoute } from "@pablozaiden/webapp/web";
import type { CreateSshSessionRequest, CreateSshServerRequest } from "@/contracts";
import type { SshServer, SshServerSession } from "@/shared/ssh-server";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import type { CreateTaskFormSubmitRequest } from "@/lib/task-request";
import type { CreateTaskFormActionState } from "../CreateTaskForm";
import { SshSessionComposer, SshServerComposer } from "./shell-composers";
import type { UseWorkspaceCreateResult } from "./use-workspace-create";
import { ComposeTaskView } from "./compose-task-view";
import { ComposeChatView } from "./compose-chat-view";
import { ComposeWorkspaceView } from "./compose-workspace-view";
import { AgentComposer } from "./agents-view";
import type { UseAgentsResult } from "../../hooks/useAgents";

type ComposeKind = "task" | "chat" | "agent" | "workspace" | "ssh-session" | "ssh-server" | "ssh-server-chat";

export function isComposeKind(value: string): value is ComposeKind {
  return [
    "task",
    "chat",
    "agent",
    "workspace",
    "ssh-session",
    "ssh-server",
    "ssh-server-chat",
  ].includes(value);
}

interface ComposeViewProps {
  kind: ComposeKind;
  composeWorkspace: Workspace | null;
  composeServer: SshServer | null;
  navigateWithinShell: (route: WebAppRoute) => void;
  composeActionState: CreateTaskFormActionState | null;
  setComposeActionState: (state: CreateTaskFormActionState | null) => void;
  handleTaskSubmit: (request: CreateTaskFormSubmitRequest) => Promise<boolean>;
  createChat: (request: import("@/contracts").CreateChatRequest) => Promise<import("@/shared").Chat | null>;
  importExistingChat: (request: import("@/contracts").ImportExistingChatRequest) => Promise<import("@/shared").Chat | null>;
  createSshServerChat: (
    serverId: string,
    request: import("@/contracts").CreateSshServerChatRequest,
  ) => Promise<import("@/shared").Chat | null>;
  dashboardData: UseDashboardDataResult;
  agents: UseAgentsResult;
  schedulerTimezone: string;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceError: string | null;
  servers: SshServer[];
  workspaceCreate: UseWorkspaceCreateResult;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sessions: SshSession[];
  createSession: (request: CreateSshSessionRequest) => Promise<SshSession>;
  createStandaloneSession: (
    serverId: string,
    options?: { name?: string; connectionMode?: SshConnectionMode; useTmux?: boolean },
  ) => Promise<SshServerSession>;
  createServer: (request: CreateSshServerRequest, password?: string) => Promise<SshServer | null>;
  updateServer: (
    id: string,
    request?: import("@/contracts").UpdateSshServerRequest,
    password?: string,
  ) => Promise<SshServer | null>;
  composeServerSessionCount: number;
  provisioning: UseProvisioningJobResult;
  workspacesSaving: boolean;
}

export function ComposeView(props: ComposeViewProps) {
  const {
    kind,
    composeWorkspace,
    composeServer,
    navigateWithinShell,
    setComposeActionState,
    handleTaskSubmit,
    createChat,
    importExistingChat,
    createSshServerChat,
    dashboardData,
    agents,
    schedulerTimezone,
    workspaces,
    workspacesLoading,
    workspaceError,
    servers,
    workspaceCreate,
    sessions: _sessions,
    createSession,
    createStandaloneSession,
    createServer,
    updateServer,
    composeServerSessionCount,
    provisioning,
    workspacesSaving,
  } = props;

  const sshWorkspaces = workspaces.filter(
    (workspace) => workspace.serverSettings.agent.transport === "ssh",
  );

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
        servers={servers}
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
        lastModel={dashboardData.lastModel}
        schedulerTimezone={schedulerTimezone}
        branches={dashboardData.branches}
        branchesLoading={dashboardData.branchesLoading}
        currentBranch={dashboardData.currentBranch}
        defaultBranch={dashboardData.defaultBranch}
        onWorkspaceChange={dashboardData.handleWorkspaceChange}
        onCreateAgent={agents.createAgent}
        navigateWithinShell={navigateWithinShell}
      />
    );
  }

  if (kind === "chat" || kind === "ssh-server-chat") {
    return (
      <ComposeChatView
        composeWorkspace={composeWorkspace}
        composeServer={kind === "ssh-server-chat" ? composeServer : null}
        workspaces={workspaces}
        workspacesLoading={workspacesLoading}
        workspaceError={workspaceError}
        dashboardData={dashboardData}
        navigateWithinShell={navigateWithinShell}
        createChat={createChat}
        importExistingChat={importExistingChat}
        createSshServerChat={createSshServerChat}
      />
    );
  }

  if (kind === "ssh-session") {
    return (
      <SshSessionComposer
        workspaces={sshWorkspaces}
        servers={servers}
        initialWorkspaceId={composeWorkspace?.id}
        initialServerId={composeServer?.config.id}
        onCancel={() =>
          navigateWithinShell(
            composeWorkspace
              ? { view: "workspace", workspaceId: composeWorkspace.id }
              : composeServer
                ? { view: "ssh-server", serverId: composeServer.config.id }
                : { view: "home" },
          )
        }
        onNavigate={navigateWithinShell}
        onCreateWorkspaceSession={createSession}
        onCreateStandaloneSession={createStandaloneSession}
      />
    );
  }

  return (
    <SshServerComposer
      initialServer={composeServer}
      relatedSessionCount={composeServerSessionCount}
      onCancel={() =>
        navigateWithinShell(
          composeServer
            ? { view: "ssh-server", serverId: composeServer.config.id }
            : { view: "home" },
        )
      }
      onNavigate={navigateWithinShell}
      onCreateServer={createServer}
      onUpdateServer={updateServer}
    />
  );
}

// Re-export the workspacesSaving prop type for ComposeView (workspace kind needs it)
export type { ComposeViewProps };
