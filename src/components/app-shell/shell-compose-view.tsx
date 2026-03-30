import type { SshSession, SshConnectionMode, Workspace } from "../../types";
import type { CreateSshSessionRequest, CreateSshServerRequest } from "../../types/api";
import type { SshServer, SshServerSession } from "../../types/ssh-server";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import type { CreateLoopFormActionState, CreateLoopFormSubmitRequest } from "../CreateLoopForm";
import { SshSessionComposer, SshServerComposer } from "./shell-composers";
import type { ComposeKind, ShellRoute } from "./shell-types";
import type { UseWorkspaceCreateResult } from "./use-workspace-create";
import { ComposeLoopView } from "./compose-loop-view";
import { ComposeWorkspaceView } from "./compose-workspace-view";

interface ComposeViewProps {
  kind: ComposeKind;
  composeWorkspace: Workspace | null;
  composeServer: SshServer | null;
  shellHeaderOffsetClassName: string;
  navigateWithinShell: (route: ShellRoute) => void;
  composeActionState: CreateLoopFormActionState | null;
  setComposeActionState: (state: CreateLoopFormActionState | null) => void;
  handleLoopSubmit: (request: CreateLoopFormSubmitRequest) => Promise<boolean>;
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
    handleLoopSubmit,
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
    provisioning,
    workspacesSaving,
  } = props;

  const sshWorkspaces = workspaces.filter(
    (workspace) => workspace.serverSettings.agent.transport === "ssh",
  );

  if (kind === "loop") {
    return (
      <ComposeLoopView
        composeWorkspace={composeWorkspace}
        shellHeaderOffsetClassName={shellHeaderOffsetClassName}
        navigateWithinShell={navigateWithinShell}
        composeActionState={composeActionState}
        setComposeActionState={setComposeActionState}
        handleLoopSubmit={handleLoopSubmit}
        dashboardData={dashboardData}
        workspaces={workspaces}
        workspacesLoading={workspacesLoading}
        workspaceError={workspaceError}
        servers={servers}
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
      onCancel={() => navigateWithinShell({ view: "home" })}
      onNavigate={navigateWithinShell}
      onCreateServer={createServer}
    />
  );
}

// Re-export the workspacesSaving prop type for ComposeView (workspace kind needs it)
export type { ComposeViewProps };
