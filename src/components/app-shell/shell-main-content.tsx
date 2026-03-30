import type { Loop, SshSession, Workspace } from "../../types";
import type { CreateSshSessionRequest } from "../../types/api";
import type { SshServer } from "../../types/ssh-server";
import type { WorkspaceExportData, WorkspaceImportResult } from "../../types/workspace";
import type { WorkspaceGroup } from "../../hooks/useLoopGrouping";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import { AppSettingsPanel } from "../AppSettingsModal";
import { LoopDetails } from "../LoopDetails";
import { SshSessionDetails } from "../SshSessionDetails";
import { SidebarIcon } from "../common";
import { ShellPanel } from "./shell-panel";
import { OverviewView, WorkspaceView, SshServerView } from "./shell-views";
import { DraftLoopComposer } from "./shell-composers";
import { ComposeView } from "./shell-compose-view";
import { RebuildWorkspaceView } from "./rebuild-workspace-view";
import { ServerAriseView } from "./server-arise-view";
import { WorkspaceSettingsView } from "./shell-workspace-settings-view";
import type { ShellRoute } from "./shell-types";
import type { UseWorkspaceCreateResult } from "./use-workspace-create";
import type { UseWorkspaceSettingsShellResult } from "./use-workspace-settings-shell";
import type {
  CreateLoopFormActionState,
  CreateLoopFormSubmitRequest,
} from "../CreateLoopForm";

interface ShellMainContentProps {
  route: ShellRoute;
  shellLoading: boolean;
  shellErrors: string[];
  sidebarCollapsed: boolean;
  shellHeaderOffsetClassName: string;
  openSidebar: () => void;
  navigateWithinShell: (route: ShellRoute) => void;

  // Data
  loops: Loop[];
  workspaces: Workspace[];
  sessions: SshSession[];
  servers: SshServer[];
  sessionsByServerId: Record<string, import("../../types/ssh-server").SshServerSession[]>;
  workspaceGroups: WorkspaceGroup[];
  workspacesLoading: boolean;
  workspacesSaving: boolean;
  workspaceError: string | null;

  // Selections
  selectedLoop: Loop | null;
  selectedWorkspace: Workspace | null;
  composeWorkspace: Workspace | null;
  composeServer: SshServer | null;
  selectedServer: SshServer | null;

  // Loop actions
  refreshLoops: () => Promise<void>;
  purgeLoop: (loopId: string) => Promise<boolean>;
  refreshSshSessions: () => Promise<void>;
  refreshSshServers: () => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  createSession: (request: CreateSshSessionRequest) => Promise<SshSession>;
  createStandaloneSession: (
    serverId: string,
    options?: { name?: string; connectionMode?: import("../../types").SshConnectionMode },
  ) => Promise<import("../../types/ssh-server").SshServerSession>;
  createServer: (
    request: import("../../types").CreateSshServerRequest,
    password?: string,
  ) => Promise<SshServer | null>;
  deleteServer: (id: string) => Promise<boolean>;
  deleteWorkspace: (id: string) => Promise<{ success: boolean; error?: string }>;
  exportConfig: () => Promise<WorkspaceExportData | null>;
  importConfig: (data: WorkspaceExportData) => Promise<WorkspaceImportResult | null>;

  // Dashboard data
  dashboardData: UseDashboardDataResult;

  // Compose state
  composeActionState: CreateLoopFormActionState | null;
  setComposeActionState: (state: CreateLoopFormActionState | null) => void;
  handleLoopSubmit: (request: CreateLoopFormSubmitRequest) => Promise<boolean>;

  // Workspace create
  workspaceCreate: UseWorkspaceCreateResult;

  // Workspace settings
  workspaceSettings: UseWorkspaceSettingsShellResult;

  // Provisioning
  provisioning: UseProvisioningJobResult;

  // Toast
  toast: import("../../hooks/useToast").ToastContextValue;
}

function renderMainContent(props: ShellMainContentProps) {
  const {
    route,
    shellLoading,
    shellHeaderOffsetClassName,
    navigateWithinShell,
    loops,
    workspaces,
    sessions,
    servers,
    sessionsByServerId,
    workspaceGroups,
    workspacesLoading,
    workspaceError,
    selectedLoop,
    selectedWorkspace,
    selectedServer,
    refreshLoops,
    refreshSshSessions,
    refreshSshServers,
    refreshWorkspaces,
    purgeLoop,
    deleteServer,
    deleteWorkspace,
    dashboardData,
    workspaceSettings,
    exportConfig,
    importConfig,
    workspacesSaving,
    toast,
  } = props;

  if (shellLoading && route.view === "home") {
    return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading…</div>;
  }

  if (route.view === "loop") {
    if (!selectedLoop) {
      return shellLoading ? (
        <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading loop…</div>
      ) : (
        <ShellPanel eyebrow="Loop" title="Loop not found" description="The selected loop no longer exists.">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Use the sidebar or home button to continue.
          </p>
        </ShellPanel>
      );
    }

    if (selectedLoop.state.status === "draft") {
      return (
        <DraftLoopComposer
          loop={selectedLoop}
          workspaces={workspaces}
          models={dashboardData.models}
          modelsLoading={dashboardData.modelsLoading}
          lastModel={dashboardData.lastModel}
          onWorkspaceChange={dashboardData.handleWorkspaceChange}
          planningWarning={dashboardData.planningWarning}
          branches={dashboardData.branches}
          branchesLoading={dashboardData.branchesLoading}
          currentBranch={dashboardData.currentBranch}
          defaultBranch={dashboardData.defaultBranch}
          registeredSshServers={servers}
          workspaceError={workspaceError}
          workspacesLoading={workspacesLoading}
          headerOffsetClassName={shellHeaderOffsetClassName}
          onRefresh={refreshLoops}
          onDeleteDraft={purgeLoop}
          onNavigate={navigateWithinShell}
        />
      );
    }

    return (
      <LoopDetails
        key={`loop:${route.loopId}`}
        loopId={route.loopId}
        onBack={() => {
          navigateWithinShell({ view: "home" });
          void refreshLoops();
        }}
        showBackButton={false}
        headerOffsetClassName={shellHeaderOffsetClassName}
        onSelectSshSession={(sshSessionId) => navigateWithinShell({ view: "ssh", sshSessionId })}
      />
    );
  }

  if (route.view === "ssh") {
    return (
      <SshSessionDetails
        sshSessionId={route.sshSessionId}
        onBack={() => {
          navigateWithinShell({ view: "home" });
          void refreshSshSessions();
          void refreshSshServers();
        }}
        showBackButton={false}
        headerOffsetClassName={shellHeaderOffsetClassName}
      />
    );
  }

  if (route.view === "workspace") {
    if (!selectedWorkspace) {
      return (
        <ShellPanel
          eyebrow="Workspace"
          title="Workspace not found"
          description="The selected workspace no longer exists."
        >
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Use the sidebar or home button to continue.
          </p>
        </ShellPanel>
      );
    }
    const relatedLoops = loops.filter((loop) => loop.config.workspaceId === selectedWorkspace.id);
    const relatedSessions = sessions.filter(
      (session) => session.config.workspaceId === selectedWorkspace.id,
    );
    return (
      <WorkspaceView
        workspace={selectedWorkspace}
        relatedLoops={relatedLoops}
        relatedSessions={relatedSessions}
        registeredSshServers={servers}
        headerOffsetClassName={shellHeaderOffsetClassName}
        onOpenSettings={() =>
          navigateWithinShell({ view: "workspace-settings", workspaceId: selectedWorkspace.id })
        }
        onNavigate={navigateWithinShell}
      />
    );
  }

  if (route.view === "workspace-settings") {
    if (!selectedWorkspace) {
      return (
        <ShellPanel
          eyebrow="Workspace"
          title="Workspace not found"
          description="The selected workspace no longer exists."
        >
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Use the sidebar or home button to continue.
          </p>
        </ShellPanel>
      );
    }

    return (
      <WorkspaceSettingsView
        selectedWorkspace={selectedWorkspace}
        workspaceSettings={workspaceSettings}
        dashboardData={dashboardData}
        refreshWorkspaces={refreshWorkspaces}
        deleteWorkspace={deleteWorkspace}
        navigateWithinShell={navigateWithinShell}
        shellHeaderOffsetClassName={shellHeaderOffsetClassName}
      />
    );
  }

  if (route.view === "ssh-server") {
    if (!selectedServer) {
      return (
        <ShellPanel
          eyebrow="SSH server"
          title="Server not found"
          description="The selected SSH server no longer exists."
        >
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Use the sidebar or home button to continue.
          </p>
        </ShellPanel>
      );
    }
    return (
      <SshServerView
        server={selectedServer}
        sessions={sessionsByServerId[selectedServer.config.id] ?? []}
        headerOffsetClassName={shellHeaderOffsetClassName}
        onNavigate={navigateWithinShell}
        onDeleteServer={async () => {
          const deleted = await deleteServer(selectedServer.config.id);
          if (!deleted) {
            toast.error(`Failed to delete SSH server "${selectedServer.config.name}"`);
            return false;
          }
          toast.success(`Deleted SSH server "${selectedServer.config.name}"`);
          navigateWithinShell({ view: "home" });
          return true;
        }}
      />
    );
  }

  if (route.view === "server-arise") {
    if (!selectedServer) {
      return (
        <ShellPanel
          eyebrow="SSH server"
          title="Server not found"
          description="The selected SSH server no longer exists."
        >
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Use the sidebar or home button to continue.
          </p>
        </ShellPanel>
      );
    }

    if (!selectedServer.config.repositoriesBasePath) {
      return (
        <ShellPanel
          eyebrow="SSH server"
          title="Automatic provisioning unavailable"
          description="This server is not configured for automatic workspace provisioning."
        >
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Add a repositories base path to enable provisioning-related actions like Arise.
          </p>
        </ShellPanel>
      );
    }

    return (
      <ServerAriseView
        server={selectedServer}
        provisioning={props.provisioning}
        shellHeaderOffsetClassName={shellHeaderOffsetClassName}
        navigateWithinShell={navigateWithinShell}
      />
    );
  }

  if (route.view === "rebuild-workspace" || route.view === "restart-workspace") {
    if (!selectedWorkspace) {
      return (
        <ShellPanel
          eyebrow="Workspace"
          title="Workspace not found"
          description="The selected workspace no longer exists."
        >
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Use the sidebar or home button to continue.
          </p>
        </ShellPanel>
      );
    }
    return (
      <RebuildWorkspaceView
        mode={route.view === "restart-workspace" ? "restart" : "rebuild"}
        workspace={selectedWorkspace}
        servers={servers}
        provisioning={props.provisioning}
        shellHeaderOffsetClassName={shellHeaderOffsetClassName}
        navigateWithinShell={navigateWithinShell}
        refreshWorkspaces={refreshWorkspaces}
      />
    );
  }

  if (route.view === "compose") {
    return (
      <ComposeView
        kind={route.kind}
        composeWorkspace={props.composeWorkspace}
        composeServer={props.composeServer}
        shellHeaderOffsetClassName={shellHeaderOffsetClassName}
        navigateWithinShell={navigateWithinShell}
        composeActionState={props.composeActionState}
        setComposeActionState={props.setComposeActionState}
        handleLoopSubmit={props.handleLoopSubmit}
        dashboardData={dashboardData}
        workspaces={workspaces}
        workspacesLoading={workspacesLoading}
        workspaceError={workspaceError}
        servers={servers}
        workspaceCreate={props.workspaceCreate}
        sessions={sessions}
        createSession={props.createSession}
        createStandaloneSession={props.createStandaloneSession}
        createServer={props.createServer}
        provisioning={props.provisioning}
        workspacesSaving={workspacesSaving}
      />
    );
  }

  if (route.view === "settings") {
    return (
      <ShellPanel
        eyebrow="App settings"
        title="Settings"
        variant="compact"
        headerOffsetClassName={shellHeaderOffsetClassName}
      >
        <AppSettingsPanel
          onResetAll={dashboardData.resetAllSettings}
          resetting={dashboardData.appSettingsResetting}
          onKillServer={dashboardData.killServer}
          killingServer={dashboardData.appSettingsKilling}
          onExportConfig={exportConfig}
          onImportConfig={importConfig}
          configSaving={workspacesSaving}
        />
      </ShellPanel>
    );
  }

  return (
    <OverviewView
      loops={loops}
      servers={servers}
      sessionsByServerId={sessionsByServerId}
      workspaceGroups={workspaceGroups}
      headerOffsetClassName={shellHeaderOffsetClassName}
      onNavigate={navigateWithinShell}
    />
  );
}

export function ShellMainContent(props: ShellMainContentProps) {
  const { shellErrors, sidebarCollapsed, openSidebar } = props;

  return (
    <div className="relative flex min-w-0 min-h-0 flex-1 flex-col overflow-hidden">
      {shellErrors.length > 0 && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200 sm:px-6">
          {shellErrors.join(" · ")}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="pointer-events-none absolute left-4 top-4 z-20 flex gap-3 sm:left-6 lg:left-8">
          <button
            type="button"
            onClick={openSidebar}
            aria-label="Open navigation"
            className="pointer-events-auto inline-flex h-10 w-10 items-center justify-center rounded-xl border border-gray-200 bg-white/95 text-gray-600 shadow-sm transition hover:border-gray-300 hover:text-gray-900 dark:border-gray-800 dark:bg-neutral-900/95 dark:text-gray-300 dark:hover:border-gray-700 dark:hover:text-gray-100 lg:hidden"
          >
            <SidebarIcon size="h-5 w-5" />
          </button>
          {sidebarCollapsed && (
            <button
              type="button"
              onClick={openSidebar}
              aria-label="Open sidebar"
              className="pointer-events-auto hidden h-10 w-10 items-center justify-center rounded-xl border border-gray-200 bg-white/95 text-gray-600 shadow-sm transition hover:border-gray-300 hover:text-gray-900 dark:border-gray-800 dark:bg-neutral-900/95 dark:text-gray-300 dark:hover:border-gray-700 dark:hover:text-gray-100 lg:inline-flex"
            >
              <SidebarIcon size="h-5 w-5" />
            </button>
          )}
        </div>
        <main className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">{renderMainContent(props)}</main>
      </div>
    </div>
  );
}
