import type { SshSession, SshConnectionMode, Workspace } from "../../types";
import type { CreateSshSessionRequest, CreateSshServerRequest } from "../../types/api";
import type { SshServer, SshServerSession } from "../../types/ssh-server";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import type { CreateTaskFormSubmitRequest } from "../../types/task-request";
import type { CreateTaskFormActionState } from "../CreateTaskForm";
import { SshSessionComposer, SshServerComposer } from "./shell-composers";
import type { ComposeKind, ShellRoute } from "./shell-types";
import type { UseWorkspaceCreateResult } from "./use-workspace-create";
import { ComposeTaskView } from "./compose-task-view";
import { ComposeChatView } from "./compose-chat-view";
import { ComposeWorkspaceView } from "./compose-workspace-view";

interface ComposeViewProps {
  kind: ComposeKind;
  composeWorkspace: Workspace | null;
  composeServer: SshServer | null;
  shellHeaderOffsetClassName: string;
  navigateWithinShell: (route: ShellRoute) => void;
  composeActionState: CreateTaskFormActionState | null;
  setComposeActionState: (state: CreateTaskFormActionState | null) => void;
  handleTaskSubmit: (request: CreateTaskFormSubmitRequest) => Promise<boolean>;
  createChat: (request: import("../../types").CreateChatRequest) => Promise<import("../../types").Chat | null>;
  dashboardData: UseDashboardDataResult;
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
    options?: { name?: string; connectionMode?: SshConnectionMode },
  ) => Promise<SshServerSession>;
  createServer: (request: CreateSshServerRequest, password?: string) => Promise<SshServer | null>;
  updateServer: (
    id: string,
    request?: import("../../types").UpdateSshServerRequest,
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
    shellHeaderOffsetClassName,
    navigateWithinShell,
    composeActionState,
    setComposeActionState,
    handleTaskSubmit,
    createChat,
    dashboardData,
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
        shellHeaderOffsetClassName={shellHeaderOffsetClassName}
        navigateWithinShell={navigateWithinShell}
        composeActionState={composeActionState}
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
        shellHeaderOffsetClassName={shellHeaderOffsetClassName}
        navigateWithinShell={navigateWithinShell}
        servers={servers}
        workspaceCreate={workspaceCreate}
        provisioning={provisioning}
        workspacesSaving={workspacesSaving}
        dashboardData={dashboardData}
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
        shellHeaderOffsetClassName={shellHeaderOffsetClassName}
        navigateWithinShell={navigateWithinShell}
        createChat={createChat}
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
        headerOffsetClassName={shellHeaderOffsetClassName}
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
      headerOffsetClassName={shellHeaderOffsetClassName}
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
