import { ErrorState, LoadingState, Page, type WebAppRoute } from "@pablozaiden/webapp/web";
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

export interface ShellMainContentProps {
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
  toast: import("@pablozaiden/webapp/web").ToastService;

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
    <ErrorState
      title="Invalid route"
      description={`The ${view} route is missing its ${parameter}. Use the sidebar or home button to continue.`}
    />
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
    return <LoadingState title="Loading Clanky" />;
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
        onGenerateAgentCode={agents.generateAgentCode}
        onTestAgentCode={agents.testAgentCode}
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
        <LoadingState title="Loading task" />
      ) : (
        <ErrorState
          title="Task not found"
          description="The selected task no longer exists. Use the sidebar or home button to continue."
        />
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
        <LoadingState title="Loading chat" />
      ) : (
        <ErrorState
          title="Chat not found"
          description="The selected chat no longer exists. Use the sidebar or home button to continue."
        />
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
        <ErrorState
          title="Workspace not found"
          description="The selected workspace no longer exists. Use the sidebar or home button to continue."
        />
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
        <ErrorState
          title="Workspace not found"
          description="The selected workspace no longer exists. Use the sidebar or home button to continue."
        />
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
        <ErrorState
          title="Workspace not found"
          description="The selected workspace no longer exists. Use the sidebar or home button to continue."
        />
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
        <ErrorState
          title="Server not found"
          description="The selected SSH server no longer exists. Use the sidebar or home button to continue."
        />
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
        <ErrorState
          title="Server not found"
          description="The selected SSH server no longer exists. Use the sidebar or home button to continue."
        />
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
        <ErrorState
          title="Server not found"
          description="The selected SSH server no longer exists. Use the sidebar or home button to continue."
        />
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
        <ErrorState
          title="Server not found"
          description="The selected SSH server no longer exists. Use the sidebar or home button to continue."
        />
      );
    }

    if (!selectedServer.config.repositoriesBasePath) {
      return (
        <ErrorState
          title="Automatic provisioning unavailable"
          description="This server is not configured for automatic workspace provisioning. Add a repositories base path to enable provisioning-related actions like Arise."
        />
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
        <ErrorState
          title="Workspace not found"
          description="The selected workspace no longer exists. Use the sidebar or home button to continue."
        />
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

function usesFullViewportLayout(props: ShellMainContentProps): boolean {
  if (props.route.view === "task") {
    return props.selectedTask?.state.status !== "draft";
  }

  return props.route.view === "agent-run"
    || props.route.view === "chat"
    || props.route.view === "code-explorer"
    || props.route.view === "ssh"
    || props.route.view === "task-files"
    || props.route.view === "vnc-session"
    || props.route.view === "workspace-files"
    || props.route.view === "server-files";
}

export function AppRouteContent(props: ShellMainContentProps) {
  const fullViewport = usesFullViewportLayout(props);
  return (
    <Page layout={fullViewport ? "full" : "padded"}>
      {props.shellErrors.length > 0 && (
        <ErrorState
          title="Some app data could not be loaded"
          description={props.shellErrors.join(" · ")}
        />
      )}
      {fullViewport
        ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {renderMainContent(props)}
          </div>
        )
        : renderMainContent(props)}
    </Page>
  );
}
