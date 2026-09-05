import { useEffect, useState } from "react";
import { ConfirmModal, ErrorState, LoadingState, Page, Panel, type WebAppRoute } from "@pablozaiden/webapp/web";
import type { Chat, ExecutionHostDescriptor, Task, Workspace } from "@/shared";
import type { SshServer } from "@/shared/ssh-server";
import type { WorkspaceGroup } from "../../hooks/useTaskGrouping";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import type { UseAgentsResult } from "../../hooks/useAgents";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import { ChatDetails } from "../ChatDetails";
import { TaskDetails } from "../TaskDetails";
import { SshServerSessionDetails } from "../SshServerSessionDetails";
import { TerminalSessionDetails } from "../terminal/terminal-session-details";
import { OverviewView, WorkspaceView, SshServerView } from "./shell-views";
import { DraftTaskComposer } from "./shell-composers";
import { ComposeView, isComposeKind } from "./shell-compose-view";
import { RebuildWorkspaceView } from "./rebuild-workspace-view";
import { ServerAriseView } from "./server-arise-view";
import { SshServerSettingsView } from "./ssh-server-settings-view";
import { VncSessionView } from "./vnc-session-view";
import { ExecutionHostView } from "./execution-host-view";
import { ExecutionHostFilesView } from "./execution-host-files-view";
import { WorkspaceSettingsView } from "./shell-workspace-settings-view";
import { WorkspacePreviewsView } from "./workspace-previews-view";
import { CodeExplorerView } from "./code-explorer-view";
import { AgentsView } from "./agents-view";
import { ProvisioningJobView } from "../ProvisioningJobView";
import { Button } from "../common";
import type { CodeExplorerTarget, SidebarServerNode, SidebarWorkspaceGroupNode } from "./shell-types";
import { getProvisioningReturnRoute, getRouteString } from "./route-fields";
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
  terminalSessions: import("@/shared").WorkspaceTerminalSession[];
  executionHosts: ExecutionHostDescriptor[];
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
  composeExecutionHost: ExecutionHostDescriptor | null;
  composeServerSessionCount: number;
  selectedServer: SshServer | null;

  // Task actions
  refreshTasks: () => Promise<void>;
  markTaskStarting: (taskId: string, status: "starting" | "planning") => void;
  clearOptimisticTaskStart: (taskId: string) => void;
  refreshChats: () => Promise<void>;
  purgeTask: (taskId: string) => Promise<boolean>;
  refreshSshServers: () => Promise<void>;
  refreshExecutionHosts: () => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  createTerminalSession: (request: import("@/contracts").CreateTerminalSessionRequest) => Promise<import("@/shared").WorkspaceTerminalSession>;
  createStandaloneSession: (
    serverId: string,
    options?: { name?: string; connectionMode?: import("@/shared").TerminalConnectionMode; useTmux?: boolean },
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
    case "execution-host": {
      const hostKind = getRouteString(route, "hostKind");
      const hostId = getRouteString(route, "hostId");
      return (hostKind === "local" || hostKind === "mesh") && hostId
        ? { contentType, hostKind, hostId, startDirectory, filePath }
        : undefined;
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

function ProvisioningJobRouteView({
  route,
  provisioning,
  navigateWithinShell,
}: {
  route: WebAppRoute;
  provisioning: UseProvisioningJobResult;
  navigateWithinShell: (route: WebAppRoute) => void;
}) {
  const [dismissConfirmOpen, setDismissConfirmOpen] = useState(false);
  const [dismissing, setDismissing] = useState(false);
  const provisioningJobId = getRouteString(route, "provisioningJobId");

  useEffect(() => {
    if (provisioningJobId) {
      provisioning.openJob(provisioningJobId);
    }
  }, [provisioning.openJob, provisioningJobId]);

  if (!provisioningJobId) {
    return missingRouteParameter(route.view, "provisioningJobId");
  }

  const snapshot = provisioning.snapshot;
  const status = snapshot?.job.state.status;
  const isTerminal = status === "completed"
    || status === "failed"
    || status === "cancelled"
    || status === "interrupted";
  const returnRoute = getProvisioningReturnRoute(route);

  async function handleDismiss(): Promise<void> {
    setDismissing(true);
    try {
      const dismissed = await provisioning.dismissJob(provisioningJobId);
      if (dismissed) {
        setDismissConfirmOpen(false);
        navigateWithinShell(returnRoute);
      }
    } finally {
      setDismissing(false);
    }
  }

  return (
    <>
      <div className="space-y-4">
        <Panel title="Provisioning">
          <ProvisioningJobView
            snapshot={snapshot}
            logs={provisioning.logs}
            websocketStatus={provisioning.websocketStatus}
            loading={provisioning.loading}
            error={provisioning.error}
          />
          {snapshot && (
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              {(status === "pending" || status === "running") && (
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  onClick={() => void provisioning.cancelJob()}
                  loading={provisioning.loading}
                >
                  Cancel
                </Button>
              )}
              {status === "completed" && snapshot.job.state.workspaceId && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => navigateWithinShell({
                    view: "workspace",
                    workspaceId: snapshot.job.state.workspaceId!,
                  })}
                >
                  Open workspace
                </Button>
              )}
              {status === "completed" && snapshot.job.config.sshServerId && snapshot.job.config.mode === "arise" && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => navigateWithinShell({
                    view: "ssh-server",
                    serverId: snapshot.job.config.sshServerId!,
                  })}
                >
                  Open server
                </Button>
              )}
              {isTerminal
                && snapshot.job.config.mode === "provision"
                && (status === "failed" || status === "cancelled" || status === "interrupted") && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => navigateWithinShell({
                      view: "compose",
                      kind: "workspace",
                      retryProvisioningJobId: provisioningJobId,
                    })}
                  >
                    Retry with this configuration
                  </Button>
                )}
              {isTerminal && (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setDismissConfirmOpen(true)}
                  loading={dismissing}
                >
                  Dismiss
                </Button>
              )}
            </div>
          )}
        </Panel>
      </div>
      <ConfirmModal
        isOpen={dismissConfirmOpen}
        onClose={() => {
          if (!dismissing) {
            setDismissConfirmOpen(false);
          }
        }}
        onConfirm={() => void handleDismiss()}
        title="Dismiss provisioning job?"
        message="This permanently removes the job, its logs, and its retry configuration."
        confirmLabel="Dismiss"
        loading={dismissing}
        variant="danger"
      />
    </>
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
    terminalSessions,
    executionHosts,
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
    refreshSshServers,
    refreshWorkspaces,
    purgeTask,
    deleteServer,
    deleteWorkspace,
    createTerminalSession,
    createStandaloneSession,
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
        modelsWorkspaceId={dashboardData.modelsWorkspaceId}
        lastModel={dashboardData.lastModel}
        selectedWorkspaceId={dashboardData.modelsWorkspaceId}
        schedulerTimezone={schedulerTimezone}
        editingAgentId={props.editingAgentId}
        onCancelAgentEdit={props.onCancelAgentEdit}
        onSavedAgentEdit={props.onSavedAgentEdit}
        onWorkspaceChange={dashboardData.handleWorkspaceChange}
        onUpdateAgent={agents.updateAgent}
        onPrepareGenerateAgentCode={agents.prepareGenerateAgentCode}
        onGenerateAgentCode={agents.generateAgentCode}
        onTestAgentCode={agents.testAgentCode}
        onDeleteRun={agents.deleteRun}
        onRefreshRuns={agents.refreshRuns}
        runsByAgentId={agents.runsByAgentId}
        route={route}
        navigateWithinShell={navigateWithinShell}
        branches={dashboardData.branches}
        branchesLoading={dashboardData.branchesLoading}
        branchesWorkspaceId={dashboardData.branchesWorkspaceId}
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
          onMarkTaskStarting={props.markTaskStarting}
          onClearOptimisticTaskStart={props.clearOptimisticTaskStart}
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
        onSelectTerminalSession={(terminalSessionId) => navigateWithinShell({ view: "terminal", terminalSessionId })}
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
        terminalSessions={terminalSessions}
        servers={servers}
        sessionsByServerId={sessionsByServerId}
        createTerminalSession={createTerminalSession}
        createStandaloneSession={createStandaloneSession}
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

  if (route.view === "terminal") {
    const terminalSessionId = getRouteString(route, "terminalSessionId");
    if (!terminalSessionId) {
      return missingRouteParameter(route.view, "terminalSessionId");
    }

    return (
      <TerminalSessionDetails
        terminalSessionId={terminalSessionId}
        onBack={() => {
          navigateWithinShell({ view: "home" });
        }}
        showBackButton={false}
      />
    );
  }

  if (route.view === "ssh") {
    const sshServerSessionId = getRouteString(route, "sshServerSessionId");
    if (!sshServerSessionId) {
      return missingRouteParameter(route.view, "sshServerSessionId");
    }
    return (
      <SshServerSessionDetails
        sshServerSessionId={sshServerSessionId}
        onBack={() => {
          navigateWithinShell({ view: "home" });
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
    const relatedTerminalSessions = terminalSessions.filter(
      (terminal) => terminal.config.workspaceId === selectedWorkspace.id,
    );
    const relatedAgents = agents.agents.filter((agent) => agent.config.workspaceId === selectedWorkspace.id);
    return (
      <WorkspaceView
        workspace={selectedWorkspace}
        relatedTasks={relatedTasks}
        relatedChats={relatedChats}
        relatedTerminalSessions={relatedTerminalSessions}
        relatedAgents={relatedAgents}
        agentsLoading={agents.loading}
        agentsError={agents.error}
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
        terminalSessions={terminalSessions}
        servers={servers}
        sessionsByServerId={sessionsByServerId}
        createTerminalSession={createTerminalSession}
        createStandaloneSession={createStandaloneSession}
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

    const selectedServerNode = serverNodes.find((node) => node.server.config.id === selectedServer.config.id);
    const relatedServerChats = [
      ...(selectedServerNode?.chats ?? []),
      ...(selectedServerNode?.historyChats ?? []),
    ].map((chatNode) => chatNode.chat);
    return (
      <SshServerView
        server={selectedServer}
        sessions={sessionsByServerId[selectedServer.config.id] ?? []}
        chats={relatedServerChats}
        onNavigate={navigateWithinShell}
        showPrivateItems={showPrivateItems}
      />
    );
  }

  if (route.view === "execution-host") {
    const hostKind = getRouteString(route, "hostKind");
    const hostId = getRouteString(route, "hostId");
    if (!hostKind || !hostId) {
      return missingRouteParameter(route.view, !hostKind ? "hostKind" : "hostId");
    }
    const host = executionHosts.find((candidate) => {
      const id = candidate.ref.kind === "ssh"
        ? candidate.ref.serverId
        : candidate.ref.nodeId;
      return candidate.ref.kind === hostKind && id === hostId;
    });
    if (!host) {
      return shellLoading
        ? <LoadingState title="Loading server" />
        : <ErrorState title="Server not found" description="The selected execution server is unavailable." />;
    }
    return (
      <ExecutionHostView
        host={host}
        provisioning={props.provisioning}
        onNavigate={navigateWithinShell}
        onRefresh={props.refreshExecutionHosts}
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
        terminalSessions={terminalSessions}
        servers={servers}
        sessionsByServerId={sessionsByServerId}
        createTerminalSession={createTerminalSession}
        createStandaloneSession={createStandaloneSession}
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
        executionHosts={executionHosts}
        workspaces={workspaces}
        terminalSessions={terminalSessions}
        servers={servers}
        sessionsByServerId={sessionsByServerId}
        createTerminalSession={createTerminalSession}
        createStandaloneSession={createStandaloneSession}
        onNavigate={navigateWithinShell}
      />
    );
  }

  if (route.view === "execution-host-files") {
    const hostKind = getRouteString(route, "hostKind");
    const hostId = getRouteString(route, "hostId");
    const host = executionHosts.find((candidate) => {
      const id = candidate.ref.kind === "ssh"
        ? candidate.ref.serverId
        : candidate.ref.nodeId;
      return candidate.ref.kind === hostKind && id === hostId;
    });
    if (!host) {
      return <ErrorState title="Server not found" description="The selected execution server is unavailable." />;
    }
    return (
      <ExecutionHostFilesView
        host={host}
        startDirectory={getRouteString(route, "startDirectory")}
        terminalSessions={terminalSessions}
        createTerminalSession={createTerminalSession}
        onNavigate={navigateWithinShell}
      />
    );
  }

  if (route.view === "provisioning-job") {
    return (
      <ProvisioningJobRouteView
        route={route}
        provisioning={props.provisioning}
        navigateWithinShell={navigateWithinShell}
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
        composeExecutionHost={props.composeExecutionHost}
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
        createTerminalSession={createTerminalSession}
        createStandaloneSession={createStandaloneSession}
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
      executionHosts={executionHosts}
      sessionsByServerId={sessionsByServerId}
      agents={agents.agents}
      agentsLoading={agents.loading}
      agentsError={agents.error}
      serverNodes={serverNodes}
      workspaceGroups={workspaceGroups}
      sidebarWorkspaceGroups={sidebarWorkspaceGroups}
      onNavigate={navigateWithinShell}
      provisioningJobs={props.provisioning.jobs}
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
    || props.route.view === "terminal"
    || props.route.view === "ssh"
    || props.route.view === "task-files"
    || props.route.view === "vnc-session"
    || props.route.view === "workspace-files"
    || props.route.view === "server-files"
    || props.route.view === "execution-host-files";
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
