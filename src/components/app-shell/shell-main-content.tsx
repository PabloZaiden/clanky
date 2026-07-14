import { Page, type WebAppRoute } from "@pablozaiden/webapp/web";
import type { Chat, Task, SshSession, Workspace } from "@/shared";
import type { CreateSshSessionRequest } from "@/contracts";
import type { SshServer } from "@/shared/ssh-server";
import type { WorkspaceGroup } from "../../hooks/useTaskGrouping";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import type { UseAgentsResult } from "../../hooks/useAgents";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import { ChatDetails } from "../ChatDetails";
import { TaskDetails } from "../TaskDetails";
import { SshSessionDetails } from "../SshSessionDetails";
import { ShellPanel } from "./shell-panel";
import { OverviewView, WorkspaceView, SshServerView } from "./shell-views";
import { DraftTaskComposer } from "./shell-composers";
import { ComposeView, isComposeKind } from "./shell-compose-view";
import { RebuildWorkspaceView } from "./rebuild-workspace-view";
import { ServerAriseView } from "./server-arise-view";
import { SshServerSettingsView } from "./ssh-server-settings-view";
import { VncSessionView } from "./vnc-session-view";
import { WorkspaceSettingsView } from "./shell-workspace-settings-view";
import { WorkspacePreviewsView } from "./workspace-previews-view";
import { CodeExplorerView } from "./code-explorer-view";
import { AgentsView } from "./agents-view";
import type { CodeExplorerTarget, SidebarServerNode, SidebarWorkspaceGroupNode } from "./shell-types";
import { getRouteString } from "./route-fields";
import type { UseWorkspaceCreateResult } from "./use-workspace-create";
import type { UseWorkspaceSettingsShellResult } from "./use-workspace-settings-shell";
import type {
  CreateTaskFormActionState,
} from "../CreateTaskForm";
import type { CreateTaskFormSubmitRequest } from "@/lib/task-request";

interface ShellMainContentProps {
  route: WebAppRoute;
  shellLoading: boolean;
  shellErrors: string[];
  navigateWithinShell: (route: WebAppRoute) => void;

  // Data
  tasks: Task[];
  chats: Chat[];
  workspaces: Workspace[];
  sessions: SshSession[];
  servers: SshServer[];
  sessionsByServerId: Record<string, import("@/shared/ssh-server").SshServerSession[]>;
  serverNodes: SidebarServerNode[];
  workspaceGroups: WorkspaceGroup[];
  sidebarWorkspaceGroups: SidebarWorkspaceGroupNode[];
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
    options?: { name?: string; connectionMode?: import("@/shared").SshConnectionMode; useTmux?: boolean },
  ) => Promise<import("@/shared/ssh-server").SshServerSession>;
  createServer: (
    request: import("@/contracts").CreateSshServerRequest,
    password?: string,
  ) => Promise<SshServer | null>;
  updateServer: (
    id: string,
    request?: import("@/contracts").UpdateSshServerRequest,
    password?: string,
  ) => Promise<SshServer | null>;
  deleteServer: (id: string) => Promise<boolean>;
  deleteWorkspace: (id: string, options?: import("@/contracts").DeleteWorkspaceRequest) => Promise<{ success: boolean; error?: string }>;

  // Dashboard data
  dashboardData: UseDashboardDataResult;
  schedulerTimezone: string;
  agents: UseAgentsResult;
  editingAgentId: string | null;
  onCancelAgentEdit: () => void;
  onSavedAgentEdit: (agent: import("@/shared").Agent) => void;

  // Compose state
  composeActionState: CreateTaskFormActionState | null;
  setComposeActionState: (state: CreateTaskFormActionState | null) => void;
  handleTaskSubmit: (request: CreateTaskFormSubmitRequest) => Promise<boolean>;
  createChat: (request: import("@/contracts").CreateChatRequest) => Promise<import("@/shared").Chat | null>;
  importExistingChat: (request: import("@/contracts").ImportExistingChatRequest) => Promise<import("@/shared").Chat | null>;
  createSshServerChat: (
    serverId: string,
    request: import("@/contracts").CreateSshServerChatRequest,
  ) => Promise<import("@/shared").Chat | null>;

  // Workspace create
  workspaceCreate: UseWorkspaceCreateResult;

  // Workspace settings
  workspaceSettings: UseWorkspaceSettingsShellResult;

  // Provisioning
  provisioning: UseProvisioningJobResult;

  // Toast
  toast: import("../../hooks/useToast").ToastContextValue;

  // Privacy preference
  showPrivateItems: boolean;
}

function getCodeExplorerTarget(route: WebAppRoute): CodeExplorerTarget | undefined {
  if (route.view !== "code-explorer") {
    return undefined;
  }

  const contentType = route["contentType"];
  const startDirectory = getRouteString(route, "startDirectory");
  const filePath = getRouteString(route, "filePath");
  if (typeof contentType !== "string") {
    return undefined;
  }

  switch (contentType) {
    case "workspace": {
      const workspaceId = getRouteString(route, "workspaceId");
      return workspaceId ? { contentType, workspaceId, startDirectory, filePath } : undefined;
    }
    case "task": {
      const taskId = getRouteString(route, "taskId");
      return taskId ? { contentType, taskId, startDirectory, filePath } : undefined;
    }
    case "server": {
      const serverId = getRouteString(route, "serverId");
      return serverId ? { contentType, serverId, startDirectory, filePath } : undefined;
    }
    case "chat": {
      const chatId = getRouteString(route, "chatId");
      return chatId ? { contentType, chatId, startDirectory, filePath } : undefined;
    }
    default:
      return undefined;
  }
}

function missingRouteParameter(view: string, parameter: string) {
  return (
    <ShellPanel
      title="Invalid route"
      description={`The ${view} route is missing its ${parameter}.`}
      variant="compact"
    >
      <p className="text-sm text-gray-500 dark:text-gray-400">
        Use the sidebar or home button to continue.
      </p>
    </ShellPanel>
  );
}

function renderMainContent(props: ShellMainContentProps) {
  const {
    route,
    shellLoading,
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
    dashboardData,
    schedulerTimezone,
    createChat,
    importExistingChat,
    workspaceSettings,
    workspacesSaving,
    agents,
    showPrivateItems,
  } = props;

  if (shellLoading && route.view === "home") {
    return <div className="p-6 text-sm text-gray-500 dark:text-gray-400">Loading…</div>;
  }

  if (route.view === "agents" || route.view === "agent" || route.view === "agent-run") {
    return (
      <AgentsView
        agents={agents.agents}
        workspaces={workspaces}
        models={dashboardData.models}
        modelsLoading={dashboardData.modelsLoading}
        lastModel={dashboardData.lastModel}
        selectedWorkspaceId={dashboardData.modelsWorkspaceId}
        schedulerTimezone={schedulerTimezone}
        editingAgentId={props.editingAgentId}
        onCancelAgentEdit={props.onCancelAgentEdit}
        onSavedAgentEdit={props.onSavedAgentEdit}
        onWorkspaceChange={dashboardData.handleWorkspaceChange}
        onUpdateAgent={agents.updateAgent}
        onDeleteRun={agents.deleteRun}
        onRefreshRuns={agents.refreshRuns}
        runsByAgentId={agents.runsByAgentId}
        route={route}
        navigateWithinShell={navigateWithinShell}
        branches={dashboardData.branches}
        branchesLoading={dashboardData.branchesLoading}
        currentBranch={dashboardData.currentBranch}
        defaultBranch={dashboardData.defaultBranch}
        loading={agents.loading}
        error={agents.error}
      />
    );
  }

  if (route.view === "task") {
    const taskId = getRouteString(route, "taskId");
    if (!taskId) {
      return missingRouteParameter(route.view, "taskId");
    }
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
          onRefresh={refreshTasks}
          onDeleteDraft={purgeTask}
          onNavigate={navigateWithinShell}
        />
      );
    }

    return (
      <TaskDetails
        key={`task:${taskId}`}
        taskId={taskId}
        onBack={() => {
          navigateWithinShell({ view: "home" });
          void refreshTasks();
        }}
        showBackButton={false}
        onSelectSshSession={(sshSessionId) => navigateWithinShell({ view: "ssh", sshSessionId })}
        onOpenTaskFiles={(selectedTaskId) => navigateWithinShell({
          view: "code-explorer",
          contentType: "task",
          taskId: selectedTaskId,
        })}
      />
    );
  }

  if (route.view === "task-files") {
    const taskId = getRouteString(route, "taskId");
    if (!taskId) {
      return missingRouteParameter(route.view, "taskId");
    }
    return (
      <CodeExplorerView
        routeTarget={{
          contentType: "task",
          taskId,
          startDirectory: getRouteString(route, "startDirectory"),
        }}
        tasks={tasks}
        chats={chats}
        workspaces={workspaces}
        sessions={sessions}
        servers={servers}
        sessionsByServerId={sessionsByServerId}
        createSession={props.createSession}
        createStandaloneSession={props.createStandaloneSession}
        onNavigate={navigateWithinShell}
      />
    );
  }

  if (route.view === "chat") {
    const chatId = getRouteString(route, "chatId");
    if (!chatId) {
      return missingRouteParameter(route.view, "chatId");
    }
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
        key={`chat:${chatId}`}
        chatId={chatId}
        onBack={() => {
          navigateWithinShell({ view: "home" });
          void refreshChats();
        }}
        showBackButton={false}
      />
    );
  }

  if (route.view === "ssh") {
    const sshSessionId = getRouteString(route, "sshSessionId");
    if (!sshSessionId) {
      return missingRouteParameter(route.view, "sshSessionId");
    }
    return (
      <SshSessionDetails
        sshSessionId={sshSessionId}
        onBack={() => {
          navigateWithinShell({ view: "home" });
          void refreshSshSessions();
          void refreshSshServers();
        }}
        showBackButton={false}
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
    const relatedAgents = agents.agents.filter((agent) => agent.config.workspaceId === selectedWorkspace.id);
    return (
      <WorkspaceView
        workspace={selectedWorkspace}
        relatedTasks={relatedTasks}
        relatedChats={relatedChats}
        relatedSessions={relatedSessions}
        relatedAgents={relatedAgents}
        agentsLoading={agents.loading}
        agentsError={agents.error}
        registeredSshServers={servers}
        onNavigate={navigateWithinShell}
        showPrivateItems={showPrivateItems}
      />
    );
  }

  if (route.view === "workspace-files") {
    const workspaceId = getRouteString(route, "workspaceId");
    if (!workspaceId) {
      return missingRouteParameter(route.view, "workspaceId");
    }
    return (
      <CodeExplorerView
        routeTarget={{
          contentType: "workspace",
          workspaceId,
          startDirectory: getRouteString(route, "startDirectory"),
        }}
        tasks={tasks}
        chats={chats}
        workspaces={workspaces}
        sessions={sessions}
        servers={servers}
        sessionsByServerId={sessionsByServerId}
        createSession={props.createSession}
        createStandaloneSession={props.createStandaloneSession}
        onNavigate={navigateWithinShell}
      />
    );
  }

  if (route.view === "workspace-previews") {
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
      <WorkspacePreviewsView
        workspace={selectedWorkspace}
        workspaces={workspaces}
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
      />
    );
  }

  if (route.view === "ssh-server") {
    const serverId = getRouteString(route, "serverId");
    if (!serverId) {
      return missingRouteParameter(route.view, "serverId");
    }
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
        onNavigate={navigateWithinShell}
        showPrivateItems={showPrivateItems}
      />
    );
  }

  if (route.view === "ssh-server-settings") {
    const serverId = getRouteString(route, "serverId");
    if (!serverId) {
      return missingRouteParameter(route.view, "serverId");
    }
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
        updateServer={props.updateServer}
        deleteServer={async () => await deleteServer(selectedServer.config.id)}
        navigateWithinShell={navigateWithinShell}
      />
    );
  }

  if (route.view === "vnc-session") {
    const serverId = getRouteString(route, "serverId");
    if (!serverId) {
      return missingRouteParameter(route.view, "serverId");
    }
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
        onNavigate={navigateWithinShell}
      />
    );
  }

  if (route.view === "server-files") {
    const serverId = getRouteString(route, "serverId");
    if (!serverId) {
      return missingRouteParameter(route.view, "serverId");
    }
    return (
      <CodeExplorerView
        routeTarget={{
          contentType: "server",
          serverId,
          startDirectory: getRouteString(route, "startDirectory"),
        }}
        tasks={tasks}
        chats={chats}
        workspaces={workspaces}
        sessions={sessions}
        servers={servers}
        sessionsByServerId={sessionsByServerId}
        createSession={props.createSession}
        createStandaloneSession={props.createStandaloneSession}
        onNavigate={navigateWithinShell}
      />
    );
  }

  if (route.view === "code-explorer") {
    return (
      <CodeExplorerView
        routeTarget={getCodeExplorerTarget(route)}
        tasks={tasks}
        chats={chats}
        workspaces={workspaces}
        sessions={sessions}
        servers={servers}
        sessionsByServerId={sessionsByServerId}
        createSession={props.createSession}
        createStandaloneSession={props.createStandaloneSession}
        onNavigate={navigateWithinShell}
      />
    );
  }

  if (route.view === "server-arise") {
    const serverId = getRouteString(route, "serverId");
    if (!serverId) {
      return missingRouteParameter(route.view, "serverId");
    }
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
        navigateWithinShell={navigateWithinShell}
        refreshWorkspaces={refreshWorkspaces}
      />
    );
  }

  if (route.view === "compose") {
    const kind = getRouteString(route, "kind");
    if (!kind || !isComposeKind(kind)) {
      return missingRouteParameter(route.view, "kind");
    }
    return (
      <ComposeView
        kind={kind}
        composeWorkspace={props.composeWorkspace}
        composeServer={props.composeServer}
        navigateWithinShell={navigateWithinShell}
        composeActionState={props.composeActionState}
        setComposeActionState={props.setComposeActionState}
        handleTaskSubmit={props.handleTaskSubmit}
        createChat={createChat}
        importExistingChat={importExistingChat}
        createSshServerChat={props.createSshServerChat}
        dashboardData={dashboardData}
        agents={agents}
        schedulerTimezone={schedulerTimezone}
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

  return (
    <OverviewView
      servers={servers}
      sessionsByServerId={sessionsByServerId}
      agents={agents.agents}
      agentsLoading={agents.loading}
      agentsError={agents.error}
      serverNodes={serverNodes}
      workspaceGroups={workspaceGroups}
      sidebarWorkspaceGroups={sidebarWorkspaceGroups}
      onNavigate={navigateWithinShell}
      showPrivateItems={showPrivateItems}
    />
  );
}

export function AppRouteContent(props: ShellMainContentProps) {
  return (
    <Page layout="full">
      {props.shellErrors.length > 0 && (
        <div className="border-b border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200 sm:px-6">
          {props.shellErrors.join(" · ")}
        </div>
      )}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {renderMainContent(props)}
      </div>
    </Page>
  );
}
