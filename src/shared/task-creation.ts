/**
 * Effective task-form defaults and preference resolution shared with Core.
 * Browser preferences are explicit inputs, never read by server-side callers.
 */

import type { CheapModelSelection, ModelConfig } from "./model";
import { DEFAULT_TASK_CONFIG, type GitConfig } from "./task";

export interface TaskCreationDefaults {
  maxIterations: number | null;
  maxConsecutiveErrors: number;
  activityTimeoutSeconds: number;
  stopPattern: string;
  git: GitConfig;
  useWorktree: boolean;
  clearPlanningFolder: boolean;
  autoAcceptPlan: boolean;
  fullyAutonomous: boolean;
  draft: boolean;
}

export function getTaskCreationDefaults({
  initial,
  planningPreferences,
  isEditing = false,
  worktreesAllowed = true,
}: {
  initial?: (Partial<Omit<TaskCreationDefaults, "activityTimeoutSeconds">> & {
    activityTimeoutSeconds?: number | null;
  }) | null;
  planningPreferences?: Pick<TaskCreationDefaults, "autoAcceptPlan" | "fullyAutonomous"> | null;
  isEditing?: boolean;
  worktreesAllowed?: boolean;
} = {}): TaskCreationDefaults {
  const planning = isEditing ? null : planningPreferences;
  return {
    maxIterations: initial?.maxIterations ?? null,
    maxConsecutiveErrors: initial?.maxConsecutiveErrors ?? DEFAULT_TASK_CONFIG.maxConsecutiveErrors,
    activityTimeoutSeconds: initial?.activityTimeoutSeconds ?? DEFAULT_TASK_CONFIG.activityTimeoutSeconds,
    stopPattern: DEFAULT_TASK_CONFIG.stopPattern,
    git: { ...DEFAULT_TASK_CONFIG.git },
    useWorktree: worktreesAllowed && (initial?.useWorktree ?? DEFAULT_TASK_CONFIG.useWorktree),
    clearPlanningFolder: initial?.clearPlanningFolder ?? DEFAULT_TASK_CONFIG.clearPlanningFolder,
    autoAcceptPlan: planning?.autoAcceptPlan ?? initial?.autoAcceptPlan ?? DEFAULT_TASK_CONFIG.autoAcceptPlan,
    // The creation form deliberately differs from the persisted task default.
    fullyAutonomous: planning?.fullyAutonomous ?? initial?.fullyAutonomous ?? true,
    draft: false,
  };
}

type ModelPreference = Omit<ModelConfig, "variant"> & { variant?: string };
type ModelOption = Pick<ModelConfig, "providerID" | "modelID"> & {
  connected: boolean;
  variants?: readonly string[];
};

function resolveAvailableModelVariant(
  models: readonly ModelOption[],
  preference: ModelPreference,
): ModelConfig | null {
  const model = models.find((entry) =>
    entry.providerID === preference.providerID && entry.modelID === preference.modelID,
  );
  if (!model) {
    return null;
  }
  const variant = preference.variant ?? "";
  return {
    providerID: model.providerID,
    modelID: model.modelID,
    variant: !model.variants?.length || model.variants.includes(variant)
      ? variant
      : model.variants[0]!,
  };
}

export function resolveTaskCreationModel({
  models,
  initialModel,
  storedModel,
  lastModel,
}: {
  models: readonly ModelOption[];
  initialModel?: ModelPreference | null;
  storedModel?: ModelPreference | null;
  lastModel?: ModelPreference | null;
}): ModelConfig | null {
  for (const preference of [initialModel, storedModel ?? lastModel]) {
    if (preference) {
      const resolved = resolveAvailableModelVariant(models, preference);
      if (resolved) {
        return resolved;
      }
    }
  }
  const firstConnected = models.find((model) => model.connected);
  return firstConnected
    ? resolveAvailableModelVariant(models, {
        ...firstConnected,
        variant: firstConnected.variants?.[0] ?? "",
      })
    : null;
}

export function resolveTaskCreationCheapModel({
  models,
  initialCheapModel,
  storedCheapModel,
  lastCheapModel,
}: {
  models: readonly ModelOption[];
  initialCheapModel?: CheapModelSelection | null;
  storedCheapModel?: CheapModelSelection | null;
  lastCheapModel?: CheapModelSelection | null;
}): CheapModelSelection {
  const preference = initialCheapModel ?? storedCheapModel ?? lastCheapModel;
  if (!preference || preference.mode === "same-as-task") {
    return { ...DEFAULT_TASK_CONFIG.cheapModel };
  }
  const model = resolveAvailableModelVariant(models, preference.model);
  const available = model && models.some((entry) =>
    entry.providerID === model.providerID && entry.modelID === model.modelID && entry.connected,
  );
  return available ? { mode: "custom", model } : { ...DEFAULT_TASK_CONFIG.cheapModel };
}
