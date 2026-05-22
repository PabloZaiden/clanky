/**
 * Aggregator for dashboard data sub-hooks.
 * Composes useAppConfig, useWorkspaceModels, useWorkspaceBranches, and usePlanningDir
 * into the unified useDashboardData hook.
 */

import { useCallback } from "react";
import { createLogger } from "../../lib/logger";
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
  models: import("../../types").ModelInfo[];
  modelsLoading: boolean;
  lastModel: import("../../types").ModelConfig | null;
  setLastModel: (model: import("../../types").ModelConfig | null) => void;
  lastCheapModel: import("../../types").CheapModelSelection | null;
  setLastCheapModel: (selection: import("../../types").CheapModelSelection | null) => void;
  modelsWorkspaceId: string | null;

  // Planning
  planningWarning: string | null;

  // Branches
  branches: import("../../types").BranchInfo[];
  branchesLoading: boolean;
  currentBranch: string;
  defaultBranch: string;

  // App settings
  appSettingsResetting: boolean;
  appSettingsKilling: boolean;
  appSettingsPurgingTerminalTasks: boolean;
  resetAllSettings: () => Promise<boolean>;
  killServer: () => Promise<boolean>;
  purgeTerminalTasks: () => Promise<import("../taskActions").PurgeTerminalTasksResult | null>;

  // Workspace change handler
  handleWorkspaceChange: (workspaceId: string | null, directory: string) => void;

  // Reset state when modal closes
  resetCreateModalState: () => void;
}

export function useDashboardData(): UseDashboardDataResult {
  const appConfig = useAppConfig();
  const workspaceModels = useWorkspaceModels();
  const workspaceBranches = useWorkspaceBranches();
  const planningDir = usePlanningDir();

  const handleWorkspaceChange = useCallback((workspaceId: string | null, directory: string) => {
    log.debug("handleWorkspaceChange called", {
      workspaceId,
      directory,
    });
    workspaceModels.setModelsWorkspaceId(workspaceId);
    log.debug("Fetching workspace data with directory:", directory);
    workspaceModels.fetchModels(directory, workspaceId);
    workspaceBranches.fetchBranches(directory, workspaceId);
    workspaceBranches.fetchDefaultBranch(directory, workspaceId);
    planningDir.checkPlanningDir(directory, workspaceId);
  }, [
    planningDir.checkPlanningDir,
    workspaceBranches.fetchBranches,
    workspaceBranches.fetchDefaultBranch,
    workspaceModels.fetchModels,
    workspaceModels.setModelsWorkspaceId,
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
    currentBranch: workspaceBranches.currentBranch,
    defaultBranch: workspaceBranches.defaultBranch,
    appSettingsResetting: appConfig.appSettingsResetting,
    appSettingsKilling: appConfig.appSettingsKilling,
    appSettingsPurgingTerminalTasks: appConfig.appSettingsPurgingTerminalTasks,
    resetAllSettings: appConfig.resetAllSettings,
    killServer: appConfig.killServer,
    purgeTerminalTasks: appConfig.purgeTerminalTasks,
    handleWorkspaceChange,
    resetCreateModalState,
  };
}
