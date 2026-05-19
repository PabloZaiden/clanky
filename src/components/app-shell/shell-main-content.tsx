import type { Chat, Loop, SshSession, Workspace } from "../../types";
import type { CreateSshSessionRequest } from "../../types/api";
import type { SshServer } from "../../types/ssh-server";
import type { WorkspaceExportData, WorkspaceImportResult } from "../../types/workspace";
import type { QuickChatSettings } from "../../types/preferences";
import type { WorkspaceGroup } from "../../hooks/useLoopGrouping";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import type { UsePasskeyAuthResult } from "../../hooks/usePasskeyAuth";
import { AppSettingsPanel } from "../AppSettingsModal";
import { ChatDetails } from "../ChatDetails";
import { LoopDetails } from "../LoopDetails";
import { SshSessionDetails } from "../SshSessionDetails";
import { SidebarIcon } from "../common";
import { ShellPanel } from "./shell-panel";
import { OverviewView, WorkspaceView, SshServerView } from "./shell-views";
import { DraftLoopComposer } from "./shell-composers";
import { ComposeView } from "./shell-compose-view";
import { RebuildWorkspaceView } from "./rebuild-workspace-view";
import { ServerAriseView } from "./server-arise-view";
import { SshServerSettingsView } from "./ssh-server-settings-view";
import { WorkspaceSettingsView } from "./shell-workspace-settings-view";
import { CodeExplorerView } from "./code-explorer-view";
import type { ShellRoute } from "./shell-types";
import type { UseWorkspaceCreateResult } from "./use-workspace-create";
import type { UseWorkspaceSettingsShellResult } from "./use-workspace-settings-shell";
import type {
  CreateLoopFormActionState,
} from "../CreateLoopForm";
import type { CreateLoopFormSubmitRequest } from "../../types/loop-request";

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
  chats: Chat[];
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
  selectedChat: Chat | null;
  selectedWorkspace: Workspace | null;
  composeWorkspace: Workspace | null;
  composeServer: SshServer | null;
  composeServerSessionCount: number;
  selectedServer: SshServer | null;

  // Loop actions
  refreshLoops: () => Promise<void>;
  refreshChats: () => Promise<void>;
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
  updateServer: (
    id: string,
    request?: import("../../types").UpdateSshServerRequest,
    password?: string,
  ) => Promise<SshServer | null>;
  deleteServer: (id: string) => Promise<boolean>;
  deleteWorkspace: (id: string, options?: import("../../types").DeleteWorkspaceRequest) => Promise<{ success: boolean; error?: string }>;
  pullLatestWorkspaceChanges: (id: string) => Promise<void>;
  pullingLatestWorkspaceIds: ReadonlySet<string>;
  exportConfig: () => Promise<WorkspaceExportData | null>;
  importConfig: (data: WorkspaceExportData) => Promise<WorkspaceImportResult | null>;

  // Dashboard data
  dashboardData: UseDashboardDataResult;
  passkeyAuth: UsePasskeyAuthResult;
  quickChatSettings: QuickChatSettings;
  quickChatSettingsLoading: boolean;
  quickChatSettingsSaving: boolean;
  quickChatSettingsError: string | null;
  updateQuickChatSettings: (settings: QuickChatSettings) => Promise<QuickChatSettings | null>;

  // Compose state
  composeActionState: CreateLoopFormActionState | null;
  setComposeActionState: (state: CreateLoopFormActionState | null) => void;
  handleLoopSubmit: (request: CreateLoopFormSubmitRequest) => Promise<boolean>;
  createChat: (request: import("../../types").CreateChatRequest) => Promise<import("../../types").Chat | null>;

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
    chats,
    workspaces,
    sessions,
    servers,
    sessionsByServerId,
    workspaceGroups,
    workspacesLoading,
    workspaceError,
    selectedLoop,
    selectedChat,
    selectedWorkspace,
    selectedServer,
    refreshLoops,
    refreshChats,
    refreshSshSessions,
    refreshSshServers,
    refreshWorkspaces,
    purgeLoop,
    deleteServer,
    deleteWorkspace,
    pullLatestWorkspaceChanges,
    pullingLatestWorkspaceIds,
    dashboardData,
    passkeyAuth,
    quickChatSettings,
    quickChatSettingsLoading,
    quickChatSettingsSaving,
    quickChatSettingsError,
    updateQuickChatSettings,
    createChat,
    workspaceSettings,
    exportConfig,
    importConfig,
    workspacesSaving,
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
          lastCheapModel={dashboardData.lastCheapModel}
          setLastModel={dashboardData.setLastModel}
          setLastCheapModel={dashboardData.setLastCheapModel}
          onWorkspaceChange={dashboardData.handleWorkspaceChange}
          planningWarning={dashboardData.planningWarning}
          branches={dashboardData.branches}
          branchesLoading={dashboardData.branchesLoading}
          currentBranch={dashboardData.currentBranch}
          defaultBranch={dashboardData.defaultBranch}
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
        onOpenLoopFiles={(loopId) => navigateWithinShell({
          view: "code-explorer",
          target: { contentType: "loop", loopId },
        })}
      />
    );
  }

  if (route.view === "loop-files") {
    return (
      <CodeExplorerView
        routeTarget={{ contentType: "loop", loopId: route.loopId, startDirectory: route.startDirectory }}
        loops={loops}
        chats={chats}
        workspaces={workspaces}
        sessions={sessions}
        servers={servers}
        sessionsByServerId={sessionsByServerId}
        headerOffsetClassName={shellHeaderOffsetClassName}
        createSession={props.createSession}
        createStandaloneSession={props.createStandaloneSession}
        onNavigate={navigateWithinShell}
      />
    );
  }

  if (route.view === "chat") {
    if (!selectedChat) {
      return shellLoading ? (
        <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading chat…</div>
      ) : (
        <ShellPanel eyebrow="Chat" title="Chat not found" description="The selected chat no longer exists.">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Use the sidebar or home button to continue.
          </p>
        </ShellPanel>
      );
    }

    return (
      <ChatDetails
        key={`chat:${route.chatId}`}
        chatId={route.chatId}
        onBack={() => {
          navigateWithinShell({ view: "home" });
          void refreshChats();
        }}
        onOpenCodeExplorer={(chatId) => navigateWithinShell({
          view: "code-explorer",
          target: { contentType: "chat", chatId },
        })}
        onOpenLoop={(loopId) => {
          navigateWithinShell({ view: "loop", loopId });
        }}
        showBackButton={false}
        headerOffsetClassName={shellHeaderOffsetClassName}
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
    const relatedChats = chats.filter((chat) => chat.config.workspaceId === selectedWorkspace.id);
    const relatedSessions = sessions.filter(
      (session) => session.config.workspaceId === selectedWorkspace.id,
    );
    return (
      <WorkspaceView
        workspace={selectedWorkspace}
        relatedLoops={relatedLoops}
        relatedChats={relatedChats}
        relatedSessions={relatedSessions}
        registeredSshServers={servers}
        headerOffsetClassName={shellHeaderOffsetClassName}
        onOpenSettings={() =>
          navigateWithinShell({ view: "workspace-settings", workspaceId: selectedWorkspace.id })
        }
        onPullLatestChanges={() => {
          void pullLatestWorkspaceChanges(selectedWorkspace.id);
        }}
        pullingLatestChanges={pullingLatestWorkspaceIds.has(selectedWorkspace.id)}
        onNavigate={navigateWithinShell}
      />
    );
  }

  if (route.view === "workspace-files") {
    return (
      <CodeExplorerView
        routeTarget={{ contentType: "workspace", workspaceId: route.workspaceId, startDirectory: route.startDirectory }}
        loops={loops}
        chats={chats}
        workspaces={workspaces}
        sessions={sessions}
        servers={servers}
        sessionsByServerId={sessionsByServerId}
        headerOffsetClassName={shellHeaderOffsetClassName}
        createSession={props.createSession}
        createStandaloneSession={props.createStandaloneSession}
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
        onOpenSettings={() => navigateWithinShell({ view: "ssh-server-settings", serverId: selectedServer.config.id })}
      />
    );
  }

  if (route.view === "ssh-server-settings") {
    if (!selectedServer) {
      return (
        <ShellPanel
          eyebrow="SSH server settings"
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
      <SshServerSettingsView
        server={selectedServer}
        relatedSessionCount={sessionsByServerId[selectedServer.config.id]?.length ?? 0}
        shellHeaderOffsetClassName={shellHeaderOffsetClassName}
        updateServer={props.updateServer}
        deleteServer={async () => await deleteServer(selectedServer.config.id)}
        navigateWithinShell={navigateWithinShell}
      />
    );
  }

  if (route.view === "server-files") {
    return (
      <CodeExplorerView
        routeTarget={{ contentType: "server", serverId: route.serverId, startDirectory: route.startDirectory }}
        loops={loops}
        chats={chats}
        workspaces={workspaces}
        sessions={sessions}
        servers={servers}
        sessionsByServerId={sessionsByServerId}
        headerOffsetClassName={shellHeaderOffsetClassName}
        createSession={props.createSession}
        createStandaloneSession={props.createStandaloneSession}
        onNavigate={navigateWithinShell}
      />
    );
  }

  if (route.view === "code-explorer") {
    return (
      <CodeExplorerView
        routeTarget={route.target}
        loops={loops}
        chats={chats}
        workspaces={workspaces}
        sessions={sessions}
        servers={servers}
        sessionsByServerId={sessionsByServerId}
        headerOffsetClassName={shellHeaderOffsetClassName}
        createSession={props.createSession}
        createStandaloneSession={props.createStandaloneSession}
        onNavigate={navigateWithinShell}
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
        createChat={createChat}
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
        updateServer={props.updateServer}
        composeServerSessionCount={props.composeServerSessionCount}
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
          passkeyAuthStatus={passkeyAuth.status}
          workspaces={workspaces}
          workspacesLoading={workspacesLoading}
          quickChatSettings={quickChatSettings}
          quickChatSettingsLoading={quickChatSettingsLoading}
          quickChatSettingsSaving={quickChatSettingsSaving}
          quickChatSettingsError={quickChatSettingsError}
          onUpdateQuickChatSettings={updateQuickChatSettings}
          registeringPasskey={passkeyAuth.registering}
          loggingOutPasskey={passkeyAuth.loggingOut}
          removingPasskey={passkeyAuth.removingPasskey}
          refreshingPasskeyAuth={passkeyAuth.refreshing}
          onRegisterPasskey={passkeyAuth.registerPasskey}
          onLogoutPasskey={passkeyAuth.logout}
          onRemovePasskey={passkeyAuth.removePasskey}
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
