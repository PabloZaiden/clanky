import type { Chat, Task, SshSession, Workspace } from "../../types";
import type { CreateSshSessionRequest } from "../../types/api";
import type { SshServer } from "../../types/ssh-server";
import type { WorkspaceExportData, WorkspaceImportResult } from "../../types/workspace";
import type { QuickChatSettings } from "../../types/preferences";
import type { WorkspaceGroup } from "../../hooks/useTaskGrouping";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import type { UseAgentsResult } from "../../hooks/useAgents";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import type { UsePasskeyAuthResult } from "../../hooks/usePasskeyAuth";
import { AppSettingsPanel } from "../AppSettingsModal";
import { ChatDetails } from "../ChatDetails";
import { TaskDetails } from "../TaskDetails";
import { SshSessionDetails } from "../SshSessionDetails";
import { SidebarIcon } from "../common";
import { ShellPanel } from "./shell-panel";
import { OverviewView, WorkspaceView, SshServerView } from "./shell-views";
import { DraftTaskComposer } from "./shell-composers";
import { ComposeView } from "./shell-compose-view";
import { RebuildWorkspaceView } from "./rebuild-workspace-view";
import { ServerAriseView } from "./server-arise-view";
import { SshServerSettingsView } from "./ssh-server-settings-view";
import { VncSessionView } from "./vnc-session-view";
import { WorkspaceSettingsView } from "./shell-workspace-settings-view";
import { CodeExplorerView } from "./code-explorer-view";
import { AgentsView } from "./agents-view";
import type { ShellRoute } from "./shell-types";
import type { SidebarServerNode, SidebarWorkspaceGroupNode, SidebarWorkspaceNode } from "./shell-types";
import type { SidebarPinningState } from "./sidebar-pins";
import type { UseWorkspaceCreateResult } from "./use-workspace-create";
import type { UseWorkspaceSettingsShellResult } from "./use-workspace-settings-shell";
import type {
  CreateTaskFormActionState,
} from "../CreateTaskForm";
import type { CreateTaskFormSubmitRequest } from "../../types/task-request";

interface ShellMainContentProps {
  route: ShellRoute;
  shellLoading: boolean;
  shellErrors: string[];
  sidebarCollapsed: boolean;
  shellHeaderOffsetClassName: string;
  openSidebar: () => void;
  navigateWithinShell: (route: ShellRoute) => void;

  // Data
  tasks: Task[];
  chats: Chat[];
  workspaces: Workspace[];
  sessions: SshSession[];
  servers: SshServer[];
  sessionsByServerId: Record<string, import("../../types/ssh-server").SshServerSession[]>;
  serverNodes: SidebarServerNode[];
  workspaceGroups: WorkspaceGroup[];
  sidebarWorkspaceGroups: SidebarWorkspaceGroupNode[];
  quickChatWorkspace: SidebarWorkspaceNode | null;
  workspacesLoading: boolean;
  workspacesSaving: boolean;
  workspaceError: string | null;

  // Selections
  selectedTask: Task | null;
  selectedChat: Chat | null;
  selectedWorkspace: Workspace | null;
  composeWorkspace: Workspace | null;
  composeServer: SshServer | null;
  composeServerSessionCount: number;
  selectedServer: SshServer | null;

  // Task actions
  refreshTasks: () => Promise<void>;
  refreshChats: () => Promise<void>;
  purgeTask: (taskId: string) => Promise<boolean>;
  refreshSshSessions: () => Promise<void>;
  refreshSshServers: () => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  createSession: (request: CreateSshSessionRequest) => Promise<SshSession>;
  createStandaloneSession: (
    serverId: string,
    options?: { name?: string; connectionMode?: import("../../types").SshConnectionMode; useTmux?: boolean },
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
  agents: UseAgentsResult;

  // Compose state
  composeActionState: CreateTaskFormActionState | null;
  setComposeActionState: (state: CreateTaskFormActionState | null) => void;
  handleTaskSubmit: (request: CreateTaskFormSubmitRequest) => Promise<boolean>;
  createChat: (request: import("../../types").CreateChatRequest) => Promise<import("../../types").Chat | null>;
  importExistingChat: (request: import("../../types").ImportExistingChatRequest) => Promise<import("../../types").Chat | null>;
  createSshServerChat: (
    serverId: string,
    request: import("../../types").CreateSshServerChatRequest,
  ) => Promise<import("../../types").Chat | null>;

  // Workspace create
  workspaceCreate: UseWorkspaceCreateResult;

  // Workspace settings
  workspaceSettings: UseWorkspaceSettingsShellResult;

  // Provisioning
  provisioning: UseProvisioningJobResult;

  // Toast
  toast: import("../../hooks/useToast").ToastContextValue;
  sidebarPinning: SidebarPinningState;
}

function renderMainContent(props: ShellMainContentProps) {
  const {
    route,
    shellLoading,
    shellHeaderOffsetClassName,
    navigateWithinShell,
    tasks,
    chats,
    workspaces,
    sessions,
    servers,
    sessionsByServerId,
    serverNodes,
    workspaceGroups,
    sidebarWorkspaceGroups,
    quickChatWorkspace,
    workspacesLoading,
    workspaceError,
    selectedTask,
    selectedChat,
    selectedWorkspace,
    selectedServer,
    refreshTasks,
    refreshChats,
    refreshSshSessions,
    refreshSshServers,
    refreshWorkspaces,
    purgeTask,
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
    importExistingChat,
    workspaceSettings,
    exportConfig,
    importConfig,
    workspacesSaving,
    sidebarPinning,
    agents,
  } = props;

  if (shellLoading && route.view === "home") {
    return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading…</div>;
  }

  if (route.view === "agents") {
    return (
      <AgentsView
        agents={agents.agents}
        workspaces={workspaces}
        models={dashboardData.models}
        modelsLoading={dashboardData.modelsLoading}
        lastModel={dashboardData.lastModel}
        selectedWorkspaceId={dashboardData.modelsWorkspaceId}
        onWorkspaceChange={dashboardData.handleWorkspaceChange}
        onCreateAgent={agents.createAgent}
        onRunAgent={agents.runAgent}
        onInterruptAgent={agents.interruptAgent}
        onDeleteAgent={agents.deleteAgent}
        onDeleteRun={agents.deleteRun}
        onPurgeRuns={agents.purgeRuns}
        onRefreshRuns={agents.refreshRuns}
        runsByAgentId={agents.runsByAgentId}
        loading={agents.loading}
        error={agents.error}
      />
    );
  }

  if (route.view === "task") {
    if (!selectedTask) {
      return shellLoading ? (
        <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading task…</div>
      ) : (
        <ShellPanel eyebrow="Task" title="Task not found" description="The selected task no longer exists.">
          <p className="text-sm text-gray-500 dark:text-gray-400">
            Use the sidebar or home button to continue.
          </p>
        </ShellPanel>
      );
    }

    if (selectedTask.state.status === "draft") {
      return (
        <DraftTaskComposer
          task={selectedTask}
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
          onRefresh={refreshTasks}
          onDeleteDraft={purgeTask}
          onNavigate={navigateWithinShell}
        />
      );
    }

    return (
      <TaskDetails
        key={`task:${route.taskId}`}
        taskId={route.taskId}
        onBack={() => {
          navigateWithinShell({ view: "home" });
          void refreshTasks();
        }}
        showBackButton={false}
        headerOffsetClassName={shellHeaderOffsetClassName}
        onSelectSshSession={(sshSessionId) => navigateWithinShell({ view: "ssh", sshSessionId })}
        onOpenTaskFiles={(taskId) => navigateWithinShell({
          view: "code-explorer",
          target: { contentType: "task", taskId },
        })}
        sidebarPinning={sidebarPinning}
      />
    );
  }

  if (route.view === "task-files") {
    return (
      <CodeExplorerView
        routeTarget={{ contentType: "task", taskId: route.taskId, startDirectory: route.startDirectory }}
        tasks={tasks}
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
        onOpenTask={(taskId) => {
          navigateWithinShell({ view: "task", taskId });
        }}
        showBackButton={false}
        headerOffsetClassName={shellHeaderOffsetClassName}
        sidebarPinning={sidebarPinning}
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
        sidebarPinning={sidebarPinning}
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
    const relatedTasks = tasks.filter((task) => task.config.workspaceId === selectedWorkspace.id);
    const relatedChats = chats.filter((chat) => chat.config.workspaceId === selectedWorkspace.id);
    const relatedSessions = sessions.filter(
      (session) => session.config.workspaceId === selectedWorkspace.id,
    );
    return (
      <WorkspaceView
        workspace={selectedWorkspace}
        relatedTasks={relatedTasks}
        relatedChats={relatedChats}
        relatedSessions={relatedSessions}
        registeredSshServers={servers}
        headerOffsetClassName={shellHeaderOffsetClassName}
        onPullLatestChanges={() => {
          void pullLatestWorkspaceChanges(selectedWorkspace.id);
        }}
        pullingLatestChanges={pullingLatestWorkspaceIds.has(selectedWorkspace.id)}
        onNavigate={navigateWithinShell}
        sidebarPinning={sidebarPinning}
      />
    );
  }

  if (route.view === "workspace-files") {
    return (
      <CodeExplorerView
        routeTarget={{ contentType: "workspace", workspaceId: route.workspaceId, startDirectory: route.startDirectory }}
        tasks={tasks}
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
        sidebarPinning={sidebarPinning}
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

  if (route.view === "vnc-session") {
    if (!selectedServer) {
      return (
        <ShellPanel
          eyebrow="VNC session"
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
      <VncSessionView
        server={selectedServer}
        headerOffsetClassName={shellHeaderOffsetClassName}
        onNavigate={navigateWithinShell}
      />
    );
  }

  if (route.view === "server-files") {
    return (
      <CodeExplorerView
        routeTarget={{ contentType: "server", serverId: route.serverId, startDirectory: route.startDirectory }}
        tasks={tasks}
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
        tasks={tasks}
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
        handleTaskSubmit={props.handleTaskSubmit}
        createChat={createChat}
        importExistingChat={importExistingChat}
        createSshServerChat={props.createSshServerChat}
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
          onPurgeTerminalTasks={async () => {
            const result = await dashboardData.purgeTerminalTasks();
            if (result) {
              await refreshTasks();
            }
            return result;
          }}
          purgingTerminalTasks={dashboardData.appSettingsPurgingTerminalTasks}
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
      servers={servers}
      sessionsByServerId={sessionsByServerId}
      serverNodes={serverNodes}
      workspaceGroups={workspaceGroups}
      sidebarWorkspaceGroups={sidebarWorkspaceGroups}
      quickChatWorkspace={quickChatWorkspace}
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
