/**
 * Dashboard component showing all tasks in a grid view.
 * Orchestrates data fetching, modal state, and task grouping via extracted hooks and components.
 */

import { useAgents, useTasks, useSshServers, useSshSessions, useWorkspaces, useViewModePreference } from "../../hooks";
import { useWorkspaceServerSettings } from "../../hooks";
import { useToast } from "../../hooks/useToast";
import { useDashboardData } from "../../hooks/useDashboardData";
import { useDashboardModals } from "../../hooks/useDashboardModals";
import { useTaskGrouping } from "../../hooks/useTaskGrouping";
import { DashboardHeader } from "../DashboardHeader";
import { TaskGrid } from "../TaskGrid";
import { DashboardModals } from "../DashboardModals";
import { CreateSshServerModal } from "../CreateSshServerModal";
import { CreateSshSessionModal } from "../CreateSshSessionModal";
import { ConfiguredAgentsSection } from "../ConfiguredAgentsSection";
import { DashboardSshSection } from "./DashboardSshSection";
import { useMemo, useState } from "react";
import type { SshServer } from "../../types";

export interface DashboardProps {
  /** Callback when a task is selected */
  onSelectTask?: (taskId: string) => void;
  /** Callback when an SSH session is selected */
  onSelectSshSession?: (sessionId: string) => void;
}

export function Dashboard({ onSelectTask, onSelectSshSession }: DashboardProps) {
  const {
    tasks,
    loading,
    error,
    refresh,
    createTask,
    purgeTask,
    purgeArchivedWorkspaceTasks,
  } = useTasks();
  const {
    sessions,
    loading: sshSessionsLoading,
    error: sshSessionsError,
    createSession,
    updateSession,
  } = useSshSessions();
  const [showCreateSshSessionModal, setShowCreateSshSessionModal] = useState(false);
  const [creatingWorkspaceSshSession, setCreatingWorkspaceSshSession] = useState(false);
  const [createWorkspaceSshSessionError, setCreateWorkspaceSshSessionError] = useState<string | null>(null);
  const [showCreateSshServerModal, setShowCreateSshServerModal] = useState(false);
  const [editingSshServer, setEditingSshServer] = useState<SshServer | null>(null);
  const {
    servers: sshServers,
    sessionsByServerId,
    loading: sshServersLoading,
    error: sshServersError,
    createServer,
    updateServer,
    deleteServer,
    createSession: createStandaloneSession,
    hasStoredCredential,
  } = useSshServers();
  const toast = useToast();

  const {
    workspaces,
    loading: workspacesLoading,
    saving: workspaceCreating,
    error: workspaceError,
    createWorkspace,
    deleteWorkspace,
    refresh: refreshWorkspaces,
    exportConfig,
    importConfig,
  } = useWorkspaces();
  const {
    agents,
    loading: agentsLoading,
    error: agentsError,
  } = useAgents();

  // Data fetching hook
  const dashboardData = useDashboardData();

  // Modal state hook
  const modals = useDashboardModals(dashboardData.resetCreateModalState);

  // Task grouping hook (memoized)
  const { workspaceGroups, unassignedTasks, unassignedStatusGroups } = useTaskGrouping(
    tasks,
    workspaces,
    !workspacesLoading,
  );
  const [workspaceArchivedTasksPurging, setWorkspaceArchivedTasksPurging] = useState(false);
  const sshWorkspaces = useMemo(() => {
    return workspaces.filter((workspace) => workspace.serverSettings.agent.transport === "ssh");
  }, [workspaces]);
  const workspaceNamesById = useMemo(() => {
    return Object.fromEntries(workspaces.map((workspace) => [workspace.id, workspace.name]));
  }, [workspaces]);
  const selectedWorkspaceArchivedTaskCount = useMemo(() => {
    if (!modals.workspaceSettingsModal.workspaceId) {
      return 0;
    }
    return workspaceGroups.find(
      (group) => group.workspace.id === modals.workspaceSettingsModal.workspaceId
    )?.statusGroups.archived.length ?? 0;
  }, [modals.workspaceSettingsModal.workspaceId, workspaceGroups]);
  const selectedWorkspaceTaskCount = useMemo(() => {
    if (!modals.workspaceSettingsModal.workspaceId) {
      return 0;
    }
    return workspaceGroups.find(
      (group) => group.workspace.id === modals.workspaceSettingsModal.workspaceId
    )?.tasks.length ?? 0;
  }, [modals.workspaceSettingsModal.workspaceId, workspaceGroups]);

  const handleSelectItem = (taskId: string) => onSelectTask?.(taskId);

  // View mode preference hook
  const { viewMode, toggle: toggleViewMode } = useViewModePreference();

  async function createWorkspaceSshSessionFor(workspaceId: string, options?: { fromModal?: boolean }) {
    const workspace = sshWorkspaces.find((item) => item.id === workspaceId);
    const reportError = (message: string) => {
      if (options?.fromModal) {
        setCreateWorkspaceSshSessionError(message);
        return;
      }
      toast.error(message);
    };

    if (!workspace) {
      reportError("The selected SSH workspace is no longer available.");
      return;
    }

    try {
      setCreatingWorkspaceSshSession(true);
      setCreateWorkspaceSshSessionError(null);
      const session = await createSession({
        workspaceId: workspace.id,
        name: `${workspace.name} terminal`,
        connectionMode: "dtach",
      });
      setShowCreateSshSessionModal(false);
      onSelectSshSession?.(session.config.id);
    } catch (error) {
      reportError(String(error));
    } finally {
      setCreatingWorkspaceSshSession(false);
    }
  }

  function handleCloseCreateSshSessionModal() {
    if (creatingWorkspaceSshSession) {
      return;
    }
    setCreateWorkspaceSshSessionError(null);
    setShowCreateSshSessionModal(false);
  }

  async function handleCreateWorkspaceSshSession() {
    if (workspacesLoading) {
      return;
    }
    if (workspaceError) {
      toast.error(workspaceError);
      return;
    }

    if (sshWorkspaces.length === 0) {
      toast.error("Create or configure a workspace with SSH transport before starting an SSH session.");
      return;
    }

    if (sshWorkspaces.length === 1) {
      await createWorkspaceSshSessionFor(sshWorkspaces[0]!.id);
      return;
    }

    setCreateWorkspaceSshSessionError(null);
    setShowCreateSshSessionModal(true);
  }

  async function handleCreateStandaloneSshSession(server: SshServer) {
    try {
      const session = await createStandaloneSession(server.config.id, {
        name: `${server.config.name} terminal`,
        connectionMode: "dtach",
      });
      onSelectSshSession?.(session.config.id);
    } catch (error) {
      toast.error(String(error));
    }
  }

  async function handlePurgeArchivedWorkspaceTasks(workspaceId: string) {
    try {
      setWorkspaceArchivedTasksPurging(true);
      const result = await purgeArchivedWorkspaceTasks(workspaceId);

      if (!result.success) {
        toast.error("Failed to purge terminal-state tasks");
        return result;
      }

      if (result.failures.length > 0) {
        toast.error(`Purged ${result.purgedCount} of ${result.totalArchived} terminal-state tasks`);
      }

      return result;
    } finally {
      setWorkspaceArchivedTasksPurging(false);
    }
  }

  // Workspace server settings hook for the workspace being edited
  const {
    workspace: workspaceFromHook,
    status: workspaceStatus,
    saving: workspaceSettingsSaving,
    testing: workspaceSettingsTesting,
    testConnection: testWorkspaceConnection,
    updateWorkspace: updateWorkspaceSettings,
  } = useWorkspaceServerSettings(modals.workspaceSettingsModal.workspaceId);

  return (
    <div className="h-full flex flex-col overflow-hidden bg-gray-50 dark:bg-neutral-900">
      <DashboardHeader
        version={dashboardData.version}
        viewMode={viewMode}
        onToggleViewMode={toggleViewMode}
        onOpenServerSettings={() => modals.setShowServerSettingsModal(true)}
        onOpenCreateWorkspace={() => modals.setShowCreateWorkspaceModal(true)}
        onOpenCreateTask={() => modals.handleOpenCreateTask()}
        onCreateSshSession={() => void handleCreateWorkspaceSshSession()}
      />

      <main className="flex-1 min-h-0 overflow-auto dark-scrollbar">
        <div className="px-4 sm:px-6 lg:px-8 py-4 sm:py-6 safe-area-bottom space-y-8">
          <DashboardSshSection
            sshServers={sshServers}
            sessionsByServerId={sessionsByServerId}
            workspaces={workspaces}
            workspacesLoaded={!workspacesLoading}
            sshServersLoading={sshServersLoading}
            sshServersError={sshServersError}
            hasStoredCredential={hasStoredCredential}
            sessions={sessions}
            sshSessionsLoading={sshSessionsLoading}
            sshSessionsError={sshSessionsError}
            onOpenCreateServer={() => {
              setEditingSshServer(null);
              setShowCreateSshServerModal(true);
            }}
            onDeleteServer={async (serverId) => {
              await deleteServer(serverId);
            }}
            onCreateSession={(server) => {
              void handleCreateStandaloneSshSession(server);
            }}
            onSelectSession={(sessionId) => onSelectSshSession?.(sessionId)}
            onRenameSession={(sessionId) => modals.setSshSessionRenameModal({ open: true, sessionId })}
          />

          <ConfiguredAgentsSection
            agents={agents}
            loading={agentsLoading}
            error={agentsError}
            description="Scheduled automations configured across your workspaces."
            emptyText="No configured agents yet."
            workspaceNamesById={workspaceNamesById}
          />

          <TaskGrid
            tasks={tasks}
            loading={loading}
            error={error}
            viewMode={viewMode}
            workspaceGroups={workspaceGroups}
            registeredSshServers={sshServers}
            unassignedTasks={unassignedTasks}
            unassignedStatusGroups={unassignedStatusGroups}
            onSelectTask={handleSelectItem}
            onEditDraft={modals.handleEditDraft}
            onOpenWorkspaceSettings={(workspaceId) => modals.setWorkspaceSettingsModal({ open: true, workspaceId })}
            onDeleteWorkspace={deleteWorkspace}
          />
        </div>
      </main>

      <DashboardModals
        tasks={tasks}
        sshSessions={sessions}
        workspaces={workspaces}
        workspacesLoading={workspacesLoading}
        workspaceError={workspaceError}
        // Create/Edit modal
        showCreateModal={modals.showCreateModal}
        editDraftId={modals.editDraftId}
        formActionState={modals.formActionState}
        setFormActionState={modals.setFormActionState}
        onCloseCreateModal={modals.handleCloseCreateModal}
        onCreateTask={createTask}
        onDeleteDraft={purgeTask}
        onRefresh={refresh}
        // Model/branch/workspace data
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
        // Uncommitted modal
        uncommittedModal={modals.uncommittedModal}
        onCloseUncommittedModal={() => modals.setUncommittedModal({ open: false, taskId: null, error: null })}
        setUncommittedModal={modals.setUncommittedModal}
        sshSessionRenameModal={modals.sshSessionRenameModal}
        onCloseSshSessionRenameModal={() => modals.setSshSessionRenameModal({ open: false, sessionId: null })}
        onRenameSshSession={async (sessionId, newName) => {
          await updateSession(sessionId, { name: newName });
        }}
        // App settings modal
        showServerSettingsModal={modals.showServerSettingsModal}
        onCloseServerSettingsModal={() => modals.setShowServerSettingsModal(false)}
        onResetAll={dashboardData.resetAllSettings}
        appSettingsResetting={dashboardData.appSettingsResetting}
        onKillServer={dashboardData.killServer}
        appSettingsKilling={dashboardData.appSettingsKilling}
        onExportConfig={exportConfig}
        onImportConfig={importConfig}
        workspaceCreating={workspaceCreating}
        // Workspace settings modal
        workspaceSettingsModal={modals.workspaceSettingsModal}
        onCloseWorkspaceSettingsModal={() => modals.setWorkspaceSettingsModal({ open: false, workspaceId: null })}
        workspaceFromHook={workspaceFromHook}
        workspaceStatus={workspaceStatus}
        workspaceSettingsSaving={workspaceSettingsSaving}
        workspaceSettingsTesting={workspaceSettingsTesting}
        workspaceArchivedTasksPurging={workspaceArchivedTasksPurging}
        testWorkspaceConnection={testWorkspaceConnection}
        updateWorkspaceSettings={updateWorkspaceSettings}
        archivedTaskCount={selectedWorkspaceArchivedTaskCount}
        workspaceTaskCount={selectedWorkspaceTaskCount}
        purgeArchivedWorkspaceTasks={handlePurgeArchivedWorkspaceTasks}
        onDeleteWorkspace={deleteWorkspace}
        refreshWorkspaces={refreshWorkspaces}
        remoteOnly={dashboardData.remoteOnly}
        // Create workspace modal
        showCreateWorkspaceModal={modals.showCreateWorkspaceModal}
        onCloseCreateWorkspaceModal={() => modals.setShowCreateWorkspaceModal(false)}
        onCreateWorkspace={createWorkspace}
        onProvisioningSuccess={refreshWorkspaces}
        sshServers={sshServers}
      />

      <CreateSshServerModal
        isOpen={showCreateSshServerModal}
        onClose={() => {
          setShowCreateSshServerModal(false);
          setEditingSshServer(null);
        }}
        initialServer={editingSshServer}
        onSubmit={(request, password) => {
          if (editingSshServer) {
            return updateServer(editingSshServer.config.id, request, password);
          }
          return createServer({ ...request, repositoriesBasePath: request.repositoriesBasePath ?? null }, password);
        }}
      />

      <CreateSshSessionModal
        isOpen={showCreateSshSessionModal}
        onClose={handleCloseCreateSshSessionModal}
        workspaces={sshWorkspaces}
        registeredSshServers={sshServers}
        onCreate={async (workspaceId) => {
          await createWorkspaceSshSessionFor(workspaceId, { fromModal: true });
        }}
        loading={creatingWorkspaceSshSession}
        error={createWorkspaceSshSessionError}
      />
    </div>
  );
}

export default Dashboard;
