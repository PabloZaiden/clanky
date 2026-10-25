/**
 * Aggregator for dashboard data sub-hooks.
 * Composes useAppConfig, useWorkspaceModels, useWorkspaceBranches, and usePlanningDir
 * into the unified useDashboardData hook.
 */

import { useCallback } from "react";
import { createLogger, type ToastService, type WebAppConfigState } from "@pablozaiden/webapp/web";
import type { WorkspaceType } from "@/shared";
import { useAppConfig } from "./use-app-config";
import { useWorkspaceModels } from "./use-workspace-models";
import { useWorkspaceBranches } from "./use-workspace-branches";
import { usePlanningDir } from "./use-planning-dir";

export type { UseAppConfigResult } from "./use-app-config";
export type { UseWorkspaceModelsResult } from "./use-workspace-models";
export type { UseWorkspaceBranchesResult } from "./use-workspace-branches";
export type { UsePlanningDirResult } from "./use-planning-dir";

const log = createLogger("useDashboardData");

export interface UseDashboardDataResult {
  // Config
  remoteOnly: boolean;
  version: string | null;

  // Models
  models: import("@/contracts").ModelInfo[];
  modelsLoading: boolean;
  lastModel: import("@/shared").ModelConfig | null;
  setLastModel: (model: import("@/shared").ModelConfig | null) => void;
  lastCheapModel: import("@/shared").CheapModelSelection | null;
  setLastCheapModel: (selection: import("@/shared").CheapModelSelection | null) => void;
  modelsWorkspaceId: string | null;

  // Planning
  planningWarning: string | null;

  // Branches
  branches: import("@/contracts").BranchInfo[];
  branchesLoading: boolean;
  branchesWorkspaceId: string | null;
  currentBranch: string;
  defaultBranch: string;
  refreshBranchData: (
    workspaceId: string | null,
    onError?: ToastService["error"],
  ) => Promise<void>;
  refreshBranchDataIfCurrent: (workspaceId: string | null) => Promise<void>;

  // App settings
  appSettingsResetting: boolean;
  appSettingsPurgingTerminalTasks: boolean;
  resetAllSettings: () => Promise<boolean>;
  purgeTerminalTasks: () => Promise<import("../taskActions").PurgeTerminalTasksResult | null>;

  // Workspace change handler
  handleWorkspaceChange: (
    workspaceId: string | null,
    directory: string,
    workspaceType?: WorkspaceType,
    onError?: ToastService["error"],
  ) => void;

  // Reset state when modal closes
  resetCreateModalState: () => void;
}

export function useDashboardData(config: WebAppConfigState["config"]): UseDashboardDataResult {
  const appConfig = useAppConfig(config);
  const workspaceModels = useWorkspaceModels();
  const workspaceBranches = useWorkspaceBranches();
  const planningDir = usePlanningDir();

  const refreshBranchData = useCallback(async (
    workspaceId: string | null,
    onError?: ToastService["error"],
  ): Promise<void> => {
    await Promise.all([
      workspaceBranches.fetchBranches(workspaceId, onError),
      workspaceBranches.fetchDefaultBranch(workspaceId, onError),
    ]);
  }, [workspaceBranches.fetchBranches, workspaceBranches.fetchDefaultBranch]);

  const refreshBranchDataIfCurrent = useCallback(async (
    workspaceId: string | null,
  ): Promise<void> => {
    if (!workspaceBranches.isCurrentWorkspace(workspaceId)) {
      return;
    }
    await refreshBranchData(workspaceId);
  }, [refreshBranchData, workspaceBranches.isCurrentWorkspace]);

  const handleWorkspaceChange = useCallback((
    workspaceId: string | null,
    _directory: string,
    workspaceType: WorkspaceType = "git",
    onError?: ToastService["error"],
  ) => {
    log.debug("handleWorkspaceChange called", {
      workspaceId,
    });
    log.debug("Fetching workspace data", { workspaceId });
    workspaceModels.fetchModels(workspaceId, onError);
    if (workspaceType === "git") {
      void refreshBranchData(workspaceId, onError);
    } else {
      workspaceBranches.resetBranches();
    }
    planningDir.checkPlanningDir(workspaceId);
  }, [
    planningDir.checkPlanningDir,
    refreshBranchData,
    workspaceBranches.resetBranches,
    workspaceModels.fetchModels,
  ]);

  const resetCreateModalState = useCallback(() => {
    workspaceModels.resetModels();
    planningDir.resetPlanningWarning();
    workspaceBranches.resetBranches();
  }, [workspaceModels.resetModels, planningDir.resetPlanningWarning, workspaceBranches.resetBranches]);

  return {
    remoteOnly: appConfig.remoteOnly,
    version: appConfig.version,
    models: workspaceModels.models,
    modelsLoading: workspaceModels.modelsLoading,
    lastModel: workspaceModels.lastModel,
    setLastModel: workspaceModels.setLastModel,
    lastCheapModel: workspaceModels.lastCheapModel,
    setLastCheapModel: workspaceModels.setLastCheapModel,
    modelsWorkspaceId: workspaceModels.modelsWorkspaceId,
    planningWarning: planningDir.planningWarning,
    branches: workspaceBranches.branches,
    branchesLoading: workspaceBranches.branchesLoading,
    branchesWorkspaceId: workspaceBranches.branchesWorkspaceId,
    currentBranch: workspaceBranches.currentBranch,
    defaultBranch: workspaceBranches.defaultBranch,
    refreshBranchData,
    refreshBranchDataIfCurrent,
    appSettingsResetting: appConfig.appSettingsResetting,
    appSettingsPurgingTerminalTasks: appConfig.appSettingsPurgingTerminalTasks,
    resetAllSettings: appConfig.resetAllSettings,
    purgeTerminalTasks: appConfig.purgeTerminalTasks,
    handleWorkspaceChange,
    resetCreateModalState,
  };
}
