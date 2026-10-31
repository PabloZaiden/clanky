import { useEffect, useMemo, useState } from "react";
import { ChatTrashView } from "./chat-trash-view";
import { WorkspaceConnectionsNotice } from "../app-settings/workspace-collaboration-content";
import { decodeCollaborationResourceReference } from "@/shared/collaboration-reference";
import type { ChatTrashActions } from "./use-chat-trash-actions";
import {
  ConfirmModal,
  ErrorState,
  LoadingState,
  Page,
  Panel,
  useHeaderActions,
  type ActionMenuItem,
  type WebAppRoute,
} from "@pablozaiden/webapp/web";
import {
  getExecutionHostSourceId,
  canRetryProvisioningJob,
  isProvisioningJobTerminal,
  isWorkerUpdateJobTerminal,
  type Chat,
  type ExecutionHostDescriptor,
  type Task,
  type Workspace,
} from "@/shared";
import type { WorkspaceGroup } from "../../hooks/useTaskGrouping";
import type { UseDashboardDataResult } from "../../hooks/useDashboardData";
import type { UseAgentsResult } from "../../hooks/useAgents";
import type { UseProvisioningJobResult } from "../../hooks/useProvisioningJob";
import type { UseWorkerUpdateJobsResult } from "../../hooks/useWorkerUpdateJobs";
import { ChatDetails } from "../ChatDetails";
import { TaskDetails } from "../TaskDetails";
import { TerminalSessionDetails } from "../terminal/terminal-session-details";
import { OverviewView, WorkspaceView } from "./shell-views";
import { DraftTaskComposer } from "./shell-composers";
import { ComposeView, isComposeKind } from "./shell-compose-view";
import { RebuildWorkspaceView } from "./rebuild-workspace-view";
import { ExecutionHostView } from "./execution-host-view";
import { ExecutionHostFilesView } from "./execution-host-files-view";
import { WorkspaceSettingsView } from "./shell-workspace-settings-view";
import { WorkspacePreviewsView } from "./workspace-previews-view";
import { CodeExplorerView } from "./code-explorer-view";
import { WorkspaceScratchpadView } from "./workspace-scratchpad-view";
import { AgentsView } from "./agents-view";
import { ProvisioningJobView } from "../ProvisioningJobView";
import { WorkerUpdateJobView } from "../WorkerUpdateJobView";
import type {
  CodeExplorerTarget,
  SidebarExecutionHostNode,
  SidebarWorkspaceGroupNode,
} from "./shell-types";
import { getProvisioningReturnRoute, getRouteString } from "./route-fields";
import type { UseWorkspaceCreateResult } from "./use-workspace-create";
import type { UseWorkspaceSettingsShellResult } from "./use-workspace-settings-shell";
import type {
  CreateTaskFormActionState,
} from "../CreateTaskForm";
import type { CreateTaskFormSubmitRequest } from "@/lib/task-request";
import type { ControlUiActionOutcome } from "@/shared/clanky-control";
import type { PendingControlFileOpen } from "./use-control-ui-actions";
import { useWorkspaceReadOnly } from "../../context/workspace-access-context";

export interface ShellMainContentProps {
  trashActions: ChatTrashActions;
  route: WebAppRoute;
  activityRoute: WebAppRoute | null;
  closeHarnessActivity: () => void;
  openHarnessActivity: (route: WebAppRoute) => void;
  shellLoading: boolean;
  shellErrors: string[];
  missingRouteTarget: boolean;
  taskRouteLoading: boolean;
  navigateWithinShell: (route: WebAppRoute) => void;

  // Data
  tasks: Task[];
  chats: Chat[];
  workspaces: Workspace[];
  pendingControlFileOpen: PendingControlFileOpen | null;
  onControlFileOpenResult: (actionId: string, outcome: ControlUiActionOutcome) => void;
  terminalSessions: import("@/shared").TerminalSession[];
  executionHosts: ExecutionHostDescriptor[];
  executionHostsLoading: boolean;
  executionHostNodes: SidebarExecutionHostNode[];
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
  composeExecutionHost: ExecutionHostDescriptor | null;

  // Task actions
  refreshTasks: () => Promise<void>;
  markTaskStarting: (taskId: string, status: "starting" | "planning") => void;
  clearOptimisticTaskStart: (taskId: string) => void;
  refreshChats: () => Promise<void>;
  purgeTask: (taskId: string) => Promise<boolean>;
  refreshExecutionHosts: () => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  createTerminalSession: (request: import("@/contracts").CreateTerminalSessionRequest) => Promise<import("@/shared").TerminalSession>;
  deleteWorkspace: (id: string, options?: import("@/contracts").DeleteWorkspaceRequest) => Promise<{ success: boolean; error?: string }>;

  // Dashboard data
  dashboardData: UseDashboardDataResult;
  agents: UseAgentsResult;
  editingAgentId: string | null;
  onSavedAgentEdit: (agent: import("@/shared").Agent) => void;

  // Compose state
  composeActionState: CreateTaskFormActionState | null;
  setComposeActionState: (state: CreateTaskFormActionState | null) => void;
  handleTaskSubmit: (request: CreateTaskFormSubmitRequest) => Promise<boolean>;
  createChat: (request: import("@/contracts").CreateChatRequest) => Promise<import("@/shared").Chat | null>;

  // Workspace create
  workspaceCreate: UseWorkspaceCreateResult;

  // Workspace settings
  workspaceSettings: UseWorkspaceSettingsShellResult;

  // Provisioning
  provisioning: UseProvisioningJobResult;
  workerUpdates: UseWorkerUpdateJobsResult;

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
  useEffect(() => {
    if (provisioningJobId && provisioning.notFoundJobId === provisioningJobId) {
      navigateWithinShell({ view: "home" });
    }
  }, [navigateWithinShell, provisioning.notFoundJobId, provisioningJobId]);

  if (!provisioningJobId) {
    return missingRouteParameter(route.view, "provisioningJobId");
  }

  const snapshot = provisioning.snapshot;
  const status = snapshot?.job.state.status;
  const isTerminal = status !== undefined && isProvisioningJobTerminal(status);
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

  const headerMenuActions = useMemo<ActionMenuItem[]>(() => {
    if (!snapshot || !provisioningJobId) {
      return [];
    }

    return [
      ...(!isTerminal ? [{
        id: "cancel",
        label: "Cancel",
        destructive: true,
        disabled: provisioning.loading,
        onAction: () => void provisioning.cancelJob(),
      }] : []),
      ...(status === "completed" && snapshot.job.state.workspaceId ? [{
        id: "open-workspace",
        label: "Open workspace",
        onAction: () => navigateWithinShell({
          view: "workspace",
          workspaceId: snapshot.job.state.workspaceId!,
        }),
      }] : []),
      ...(status === "completed"
        && snapshot.job.config.mode === "arise" ? [{
          id: "open-server",
          label: "Open server",
          onAction: () => navigateWithinShell({
            view: "execution-host",
            hostKind: snapshot.job.config.executionHostBinding.host.kind,
            hostId: getExecutionHostSourceId(snapshot.job.config.executionHostBinding.host),
          }),
        }] : []),
      ...(canRetryProvisioningJob(snapshot.job) ? [{
          id: "retry",
          label: "Retry",
          onAction: () => navigateWithinShell({
            view: "compose",
            kind: "workspace",
            retryProvisioningJobId: provisioningJobId,
          }),
        }] : []),
      ...(isTerminal ? [{
        id: "dismiss",
        label: "Dismiss",
        destructive: true,
        disabled: dismissing,
        onAction: () => setDismissConfirmOpen(true),
      }] : []),
    ];
  }, [
    dismissing,
    isTerminal,
    navigateWithinShell,
    provisioning,
    provisioningJobId,
    snapshot,
    status,
  ]);
  useHeaderActions({ overflow: headerMenuActions });

  if (provisioning.notFoundJobId === provisioningJobId) {
    return null;
  }

  return (
    <>
      <div className="space-y-4">
        <Panel>
          <ProvisioningJobView
            snapshot={snapshot}
            logs={provisioning.logs}
            websocketStatus={provisioning.websocketStatus}
            loading={provisioning.loading || provisioning.activeJobId !== provisioningJobId}
            error={provisioning.error}
          />
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

function WorkerUpdateJobRouteView({
  route,
  workerUpdates,
  navigateWithinShell,
}: {
  route: WebAppRoute;
  workerUpdates: UseWorkerUpdateJobsResult;
  navigateWithinShell: (route: WebAppRoute) => void;
}) {
  const workerUpdateJobId = getRouteString(route, "workerUpdateJobId");
  if (!workerUpdateJobId) {
    return missingRouteParameter(route.view, "workerUpdateJobId");
  }

  return (
    <WorkerUpdateJobRouteContent
      workerUpdateJobId={workerUpdateJobId}
      workerUpdates={workerUpdates}
      navigateWithinShell={navigateWithinShell}
    />
  );
}

function WorkerUpdateJobRouteContent({
  workerUpdateJobId,
  workerUpdates,
  navigateWithinShell,
}: {
  workerUpdateJobId: string;
  workerUpdates: UseWorkerUpdateJobsResult;
  navigateWithinShell: (route: WebAppRoute) => void;
}) {
  const [dismissConfirmOpen, setDismissConfirmOpen] = useState(false);
  const [dismissing, setDismissing] = useState(false);

  useEffect(() => {
    workerUpdates.openJob(workerUpdateJobId);
  }, [workerUpdateJobId, workerUpdates.openJob]);
  useEffect(() => {
    if (workerUpdates.notFoundJobId === workerUpdateJobId) {
      navigateWithinShell({ view: "home" });
    }
  }, [navigateWithinShell, workerUpdateJobId, workerUpdates.notFoundJobId]);

  const snapshot = workerUpdates.snapshot?.job.config.id === workerUpdateJobId
    ? workerUpdates.snapshot
    : null;
  const status = snapshot?.job.state.status;
  const isTerminal = status !== undefined && isWorkerUpdateJobTerminal(status);

  async function handleDismiss(): Promise<void> {
    setDismissing(true);
    try {
      const dismissed = await workerUpdates.dismissJob(workerUpdateJobId);
      if (dismissed) {
        setDismissConfirmOpen(false);
        navigateWithinShell({ view: "home" });
      }
    } finally {
      setDismissing(false);
    }
  }

  const headerMenuActions = useMemo<ActionMenuItem[]>(() => {
    if (!snapshot || !isTerminal) {
      return [];
    }
    return [{
      id: "dismiss",
      label: "Dismiss",
      destructive: true,
      disabled: dismissing,
      onAction: () => setDismissConfirmOpen(true),
    }];
  }, [dismissing, isTerminal, snapshot]);
  useHeaderActions({ overflow: headerMenuActions });

  if (workerUpdates.notFoundJobId === workerUpdateJobId) {
    return null;
  }

  return (
    <>
      <div className="space-y-4">
        <Panel>
          <WorkerUpdateJobView
            snapshot={snapshot}
            loading={workerUpdates.enabled
              && (workerUpdates.loading || workerUpdates.activeJobId !== workerUpdateJobId)}
            error={workerUpdates.enabled
              ? workerUpdates.error
              : "Worker update jobs are only available to the owner."}
          />
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
        title="Dismiss worker update job?"
        message="This permanently removes the job and its logs."
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
    executionHostNodes,
    workspaceGroups,
    sidebarWorkspaceGroups,
    workspacesLoading,
    workspaceError,
    selectedTask,
    selectedChat,
    selectedWorkspace,
    refreshTasks,
    refreshWorkspaces,
    purgeTask,
    deleteWorkspace,
    createTerminalSession,
    dashboardData,
    createChat,
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
        editingAgentId={props.editingAgentId}
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

    if (selectedTask.state.status === "draft" && selectedWorkspace?.access !== "read"
      && workspaces.find((workspace) => workspace.id === selectedTask.config.workspaceId)?.access !== "read") {
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
          branchesWorkspaceId={dashboardData.branchesWorkspaceId}
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
        onMissingEntity={() => navigateWithinShell({ view: "home" })}
        showActivity={props.activityRoute?.view === "task" && props.activityRoute["taskId"] === taskId}
        onCloseActivity={props.closeHarnessActivity}
        onOpenActivity={() => props.openHarnessActivity({ view: "task", taskId })}
        onBack={() => {
          navigateWithinShell({ view: "home" });
          void refreshTasks();
        }}
        onSelectTerminalSession={(terminalSessionId) => navigateWithinShell({ view: "terminal", terminalSessionId })}
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
        createTerminalSession={createTerminalSession}
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
        onMissingEntity={() => navigateWithinShell({ view: "home" })}
        showActivity={props.activityRoute?.view === "chat" && props.activityRoute["chatId"] === chatId}
        onCloseActivity={props.closeHarnessActivity}
        onOpenActivity={() => props.openHarnessActivity({ view: "chat", chatId })}
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
        key={`terminal:${terminalSessionId}`}
        terminalSessionId={terminalSessionId}
        onMissingEntity={() => navigateWithinShell({ view: "home" })}
      />
    );
  }

  if (route.view === "workspace") {
    if (!selectedWorkspace) {
      if (workspacesLoading) {
        return <LoadingState title="Loading workspace" />;
      }
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

  if (route.view === "scratchpad") {
    const workspaceId = getRouteString(route, "workspaceId");
    if (!workspaceId) {
      return missingRouteParameter(route.view, "workspaceId");
    }
    return (
      <WorkspaceScratchpadView
        key={`workspace-scratchpad:${workspaceId}`}
        workspaceId={workspaceId}
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
        createTerminalSession={createTerminalSession}
        onNavigate={navigateWithinShell}
      />
    );
  }

  if (route.view === "workspace-previews") {
    if (!selectedWorkspace) {
      if (workspacesLoading) {
        return <LoadingState title="Loading workspace" />;
      }
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
    const workspaceId = getRouteString(route, "workspaceId");
    if (!selectedWorkspace) {
      if (workspacesLoading) {
        return <LoadingState title="Loading workspace" />;
      }
      return (
        <ErrorState
          title="Workspace not found"
          description="The selected workspace no longer exists. Use the sidebar or home button to continue."
        />
      );
    }
    if (workspaceId && decodeCollaborationResourceReference(workspaceId) && selectedWorkspace.access !== "admin") {
      return <ErrorState title="Workspace administration access required" />;
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

  if (route.view === "execution-host") {
    const hostKind = getRouteString(route, "hostKind");
    const hostId = getRouteString(route, "hostId");
    if (!hostKind || !hostId) {
      return missingRouteParameter(route.view, !hostKind ? "hostKind" : "hostId");
    }
    const host = executionHosts.find((candidate) => {
      const id = getExecutionHostSourceId(candidate.ref);
      return candidate.ref.kind === hostKind && id === hostId;
    });
    if (!host) {
      return shellLoading
        ? <LoadingState title="Loading server" />
        : <ErrorState title="Server not found" description="The selected execution server is unavailable." />;
    }
    const hostSessions = terminalSessions.filter((session) => (
      !session.config.workspaceId
      && session.config.executionHostBinding.targetKey === host.targetKey
    ));
    const hostChats = chats.filter((chat) => (
      chat.config.source?.kind === "execution_host"
      && chat.config.source.executionHost.targetKey === host.targetKey
    ));
    const hostWorkspaces = workspaces.filter((workspace) => (
      workspace.executionHostBinding.targetKey === host.targetKey
    ));
    return (
      <ExecutionHostView
        host={host}
        executionHosts={executionHosts}
        workspaces={hostWorkspaces}
        sessions={hostSessions}
        chats={hostChats}
        provisioning={props.provisioning}
        onNavigate={navigateWithinShell}
        onRefresh={props.refreshExecutionHosts}
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
        pendingControlFileOpen={props.pendingControlFileOpen}
        onControlFileOpenResult={props.onControlFileOpenResult}
        terminalSessions={terminalSessions}
        createTerminalSession={createTerminalSession}
        onNavigate={navigateWithinShell}
      />
    );
  }

  if (route.view === "execution-host-files") {
    if (props.executionHostsLoading) {
      return <LoadingState title="Loading server" />;
    }
    const hostKind = getRouteString(route, "hostKind");
    const hostId = getRouteString(route, "hostId");
    const host = executionHosts.find((candidate) => {
      const id = getExecutionHostSourceId(candidate.ref);
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
        key={getRouteString(route, "provisioningJobId")}
        route={route}
        provisioning={props.provisioning}
        navigateWithinShell={navigateWithinShell}
      />
    );
  }

  if (route.view === "worker-update-job") {
    return (
      <WorkerUpdateJobRouteView
        key={getRouteString(route, "workerUpdateJobId")}
        route={route}
        workerUpdates={props.workerUpdates}
        navigateWithinShell={navigateWithinShell}
      />
    );
  }

  if (route.view === "rebuild-workspace" || route.view === "restart-workspace") {
    if (!selectedWorkspace) {
      if (workspacesLoading) {
        return <LoadingState title="Loading workspace" />;
      }
      return (
        <ErrorState
          title="Workspace not found"
          description="The selected workspace no longer exists. Use the sidebar or home button to continue."
        />
      );
    }
    return (
      <RebuildWorkspaceView
        key={`${route.view}:${selectedWorkspace.id}`}
        mode={route.view === "restart-workspace" ? "restart" : "rebuild"}
        workspace={selectedWorkspace}
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
        composeExecutionHost={props.composeExecutionHost}
        navigateWithinShell={navigateWithinShell}
        composeActionState={props.composeActionState}
        setComposeActionState={props.setComposeActionState}
        handleTaskSubmit={props.handleTaskSubmit}
        createChat={createChat}
        dashboardData={dashboardData}
        agents={agents}
        workspaces={workspaces.filter((workspace) => workspace.access !== "read")}
        workspacesLoading={workspacesLoading}
        workspaceError={workspaceError}
        workspaceCreate={props.workspaceCreate}
        createTerminalSession={createTerminalSession}
        provisioning={props.provisioning}
        workspacesSaving={workspacesSaving}
      />
    );
  }

  return (
    <OverviewView
      executionHosts={executionHosts}
      executionHostNodes={executionHostNodes}
      agents={agents.agents}
      agentsLoading={agents.loading}
      agentsError={agents.error}
      workspaceGroups={workspaceGroups}
      sidebarWorkspaceGroups={sidebarWorkspaceGroups}
      onNavigate={navigateWithinShell}
      provisioningJobs={props.provisioning.jobs}
      onDismissAllProvisioningJobs={props.provisioning.dismissAllJobs}
      dismissingAllProvisioningJobs={props.provisioning.dismissingAllJobs}
      workerUpdateJobs={props.workerUpdates.jobs}
      onDismissAllWorkerUpdateJobs={props.workerUpdates.dismissAllJobs}
      dismissingAllWorkerUpdateJobs={props.workerUpdates.dismissingAllJobs}
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
    || props.route.view === "scratchpad"
    || props.route.view === "terminal"
    || props.route.view === "task-files"
    || props.route.view === "workspace-files"
    || props.route.view === "workspace-settings"
    || props.route.view === "execution-host-files";
}

export function AppRouteContent(props: ShellMainContentProps) {
  const readOnly = useWorkspaceReadOnly();
  if (readOnly && ["compose", "terminal", "workspace-previews", "workspace-settings", "restart-workspace", "rebuild-workspace"].includes(props.route.view)) {
    return <Page><ErrorState title="Read-only workspace" description="This action requires work access." /></Page>;
  }
  if (props.route.view === "trash") {
    return (
      <Page>
        <WorkspaceConnectionsNotice />
        <ChatTrashView
          showPrivateItems={props.showPrivateItems}
          selectedChatId={getRouteString(props.route, "chatId")}
          actions={props.trashActions}
        />
      </Page>
    );
  }
  const fullViewport = usesFullViewportLayout(props);
  return (
    <Page layout={fullViewport ? "full" : "padded"}>
      {readOnly ? <p role="status" className="shrink-0 px-3 py-2 text-sm text-gray-500 dark:text-gray-400">Read-only workspace</p> : null}
      <WorkspaceConnectionsNotice />
      {props.shellErrors.length > 0 && (
        <ErrorState
          title="Some app data could not be loaded"
          description={props.shellErrors.join(" · ")}
        />
      )}
      {props.missingRouteTarget ? (
        <LoadingState title="Returning home" />
      ) : props.taskRouteLoading ? (
        <LoadingState title="Loading task" />
      ) : fullViewport
        ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {renderMainContent(props)}
          </div>
        )
        : renderMainContent(props)}
    </Page>
  );
}
