/**
 * Dashboard modal renderings — aggregates all modal components used in the Dashboard.
 */

import type {
  Loop,
  UncommittedChangesError,
  ModelInfo,
  ModelConfig,
  BranchInfo,
  Workspace,
  CreateLoopRequest,
  SshSession,
  SshServer,
} from "../../types";
import type { WorkspaceExportData, WorkspaceImportResult, CreateWorkspaceRequest } from "../../types/workspace";
import type { CreateLoopFormActionState } from "../CreateLoopForm";
import type { PurgeArchivedLoopsResult } from "../../hooks";
import type { CreateLoopResult } from "../../hooks/useLoops";
import type { UseWorkspaceServerSettingsResult } from "../../hooks/useWorkspaceServerSettings";
import {
  UncommittedChangesModal,
} from "../LoopModals";
import { AppSettingsModal } from "../AppSettingsModal";
import { RenameSshSessionModal } from "../RenameSshSessionModal";
import { WorkspaceSettingsModal } from "../WorkspaceSettingsModal";
import { CreateWorkspaceModal } from "../CreateWorkspaceModal";
import { CreateEditLoopModal } from "./create-edit-loop-modal";

export interface DashboardModalsProps {
  loops: Loop[];
  sshSessions: SshSession[];
  workspaces: Workspace[];
  workspacesLoading: boolean;
  workspaceError: string | null;

  // Create/Edit modal
  showCreateModal: boolean;
  editDraftId: string | null;
  formActionState: CreateLoopFormActionState | null;
  setFormActionState: (state: CreateLoopFormActionState | null) => void;
  onCloseCreateModal: () => void;
  onCreateLoop: (request: CreateLoopRequest) => Promise<CreateLoopResult>;
  onDeleteDraft: (loopId: string) => Promise<boolean>;
  onRefresh: () => Promise<void>;

  // Model/branch/workspace data for create form
  models: ModelInfo[];
  modelsLoading: boolean;
  lastModel: ModelConfig | null;
  lastCheapModel: import("../../types").CheapModelSelection | null;
  setLastModel: (model: ModelConfig | null) => void;
  setLastCheapModel: (selection: import("../../types").CheapModelSelection | null) => void;
  onWorkspaceChange: (workspaceId: string | null, directory: string) => void;
  planningWarning: string | null;
  branches: BranchInfo[];
  branchesLoading: boolean;
  currentBranch: string;
  defaultBranch: string;

  // Uncommitted changes modal
  uncommittedModal: { open: boolean; loopId: string | null; error: UncommittedChangesError | null };
  onCloseUncommittedModal: () => void;
  setUncommittedModal: (state: { open: boolean; loopId: string | null; error: UncommittedChangesError | null }) => void;

  sshSessionRenameModal: { open: boolean; sessionId: string | null };
  onCloseSshSessionRenameModal: () => void;
  onRenameSshSession: (sessionId: string, newName: string) => Promise<void>;

  // App settings modal
  showServerSettingsModal: boolean;
  onCloseServerSettingsModal: () => void;
  onResetAll: () => Promise<boolean>;
  appSettingsResetting: boolean;
  onKillServer: () => Promise<boolean>;
  appSettingsKilling: boolean;
  onExportConfig: () => Promise<WorkspaceExportData | null>;
  onImportConfig: (data: WorkspaceExportData) => Promise<WorkspaceImportResult | null>;
  workspaceCreating: boolean;

  // Workspace settings modal
  workspaceSettingsModal: { open: boolean; workspaceId: string | null };
  onCloseWorkspaceSettingsModal: () => void;
  workspaceFromHook: UseWorkspaceServerSettingsResult["workspace"];
  workspaceStatus: UseWorkspaceServerSettingsResult["status"];
  workspaceSettingsSaving: boolean;
  workspaceSettingsTesting: boolean;
  workspaceArchivedLoopsPurging: boolean;
  testWorkspaceConnection: UseWorkspaceServerSettingsResult["testConnection"];
  updateWorkspaceSettings: UseWorkspaceServerSettingsResult["updateWorkspace"];
  archivedLoopCount: number;
  workspaceLoopCount: number;
  purgeArchivedWorkspaceLoops: (workspaceId: string) => Promise<PurgeArchivedLoopsResult>;
  onDeleteWorkspace: (workspaceId: string) => Promise<{ success: boolean; error?: string }>;
  refreshWorkspaces: () => Promise<void>;
  remoteOnly: boolean;

  // Create workspace modal
  showCreateWorkspaceModal: boolean;
  onCloseCreateWorkspaceModal: () => void;
  onCreateWorkspace: (request: CreateWorkspaceRequest) => Promise<Workspace | null>;
  onProvisioningSuccess?: () => Promise<void>;
  sshServers: SshServer[];
}

export function DashboardModals(props: DashboardModalsProps) {
  return (
    <>
      {/* Create/Edit modal */}
      <CreateEditLoopModal
        loops={props.loops}
        showCreateModal={props.showCreateModal}
        editDraftId={props.editDraftId}
        formActionState={props.formActionState}
        setFormActionState={props.setFormActionState}
        onCloseCreateModal={props.onCloseCreateModal}
        onCreateLoop={props.onCreateLoop}
        onDeleteDraft={props.onDeleteDraft}
        onRefresh={props.onRefresh}
        models={props.models}
        modelsLoading={props.modelsLoading}
        lastModel={props.lastModel}
        lastCheapModel={props.lastCheapModel}
        setLastModel={props.setLastModel}
        setLastCheapModel={props.setLastCheapModel}
        onWorkspaceChange={props.onWorkspaceChange}
        planningWarning={props.planningWarning}
        branches={props.branches}
        branchesLoading={props.branchesLoading}
        currentBranch={props.currentBranch}
        defaultBranch={props.defaultBranch}
        workspaces={props.workspaces}
        workspacesLoading={props.workspacesLoading}
        workspaceError={props.workspaceError}
        setUncommittedModal={props.setUncommittedModal}
      />

      {/* Uncommitted changes modal */}
      <UncommittedChangesModal
        isOpen={props.uncommittedModal.open}
        onClose={props.onCloseUncommittedModal}
        error={props.uncommittedModal.error}
      />

      {/* App Settings modal */}
      <AppSettingsModal
        isOpen={props.showServerSettingsModal}
        onClose={props.onCloseServerSettingsModal}
        onResetAll={props.onResetAll}
        resetting={props.appSettingsResetting}
        onKillServer={props.onKillServer}
        killingServer={props.appSettingsKilling}
        onExportConfig={props.onExportConfig}
        onImportConfig={props.onImportConfig}
        configSaving={props.workspaceCreating}
      />

      <RenameSshSessionModal
        isOpen={props.sshSessionRenameModal.open}
        onClose={props.onCloseSshSessionRenameModal}
        currentName={props.sshSessions.find((session) => session.config.id === props.sshSessionRenameModal.sessionId)?.config.name ?? ""}
        onRename={async (newName) => {
          if (props.sshSessionRenameModal.sessionId) {
            await props.onRenameSshSession(props.sshSessionRenameModal.sessionId, newName);
          }
        }}
      />

      {/* Workspace Settings modal */}
      <WorkspaceSettingsModal
        isOpen={props.workspaceSettingsModal.open}
        onClose={props.onCloseWorkspaceSettingsModal}
        workspace={props.workspaceFromHook}
        status={props.workspaceStatus}
        onSave={async (name, settings) => {
          if (!props.workspaceSettingsModal.workspaceId) return false;
          const success = await props.updateWorkspaceSettings(name, settings);
          if (success) {
            await props.refreshWorkspaces();
          }
          return success;
        }}
        onTest={props.testWorkspaceConnection}
        onPurgeArchivedLoops={async () => {
          if (!props.workspaceSettingsModal.workspaceId) {
            return {
              success: false,
              workspaceId: "",
              totalArchived: 0,
              purgedCount: 0,
              purgedLoopIds: [],
              failures: [],
            };
          }
          return await props.purgeArchivedWorkspaceLoops(props.workspaceSettingsModal.workspaceId);
        }}
        onDeleteWorkspace={async () => {
          if (!props.workspaceSettingsModal.workspaceId) {
            return {
              success: false,
              error: "Workspace settings are unavailable right now.",
            };
          }
          return await props.onDeleteWorkspace(props.workspaceSettingsModal.workspaceId);
        }}
        purgeableLoopCount={props.archivedLoopCount}
        workspaceLoopCount={props.workspaceLoopCount}
        saving={props.workspaceSettingsSaving}
        testing={props.workspaceSettingsTesting}
        purgingPurgeableLoops={props.workspaceArchivedLoopsPurging}
        remoteOnly={props.remoteOnly}
      />

      {/* Create Workspace modal */}
      <CreateWorkspaceModal
        isOpen={props.showCreateWorkspaceModal}
        onClose={props.onCloseCreateWorkspaceModal}
        onCreate={async (request) => {
          const result = await props.onCreateWorkspace(request);
          return !!result;
        }}
        creating={props.workspaceCreating}
        error={props.workspaceError}
        remoteOnly={props.remoteOnly}
        registeredSshServers={props.sshServers}
        onProvisioningSuccess={props.onProvisioningSuccess}
      />
    </>
  );
}
