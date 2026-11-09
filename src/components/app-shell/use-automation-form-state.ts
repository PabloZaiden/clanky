import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { BranchInfo, ModelInfo } from "@/contracts";
import type { Automation, ModelConfig, Workspace } from "@/shared";
import type { CreateAutomationRequest, UpdateAutomationRequest } from "@/contracts/schemas";
import { useToast } from "@pablozaiden/webapp/web";
import { makeModelKey, modelVariantExists, parseModelKey } from "../ModelSelector";
import type { UseAutomationsResult } from "../../hooks/useAutomations";
import { useWorkspaceSchedulerTimezone } from "../../hooks/useWorkspaceSchedulerTimezone";
import {
  isWorkspaceBranchSelectionValid,
  resolveWorkspaceBranchSelection,
} from "../../lib/workspace-branch-selection";

export type AutomationFormMode = "create" | "edit";
export type AutomationFormIntervalUnit = "minutes" | "hours" | "days";

export interface AutomationFormDraft {
  name: string;
  prompt: string;
  workspaceId: string;
  modelKey: string;
  baseBranch: string;
  useWorktree: boolean;
  startAtLocal: string;
  startAtTouched: boolean;
  intervalValue: number;
  intervalUnit: AutomationFormIntervalUnit;
}

type AutomationFormAction =
  | { type: "set-name"; value: string }
  | { type: "set-prompt"; value: string }
  | { type: "set-workspace-id"; value: string }
  | { type: "set-model-key"; value: string }
  | { type: "set-base-branch"; value: string }
  | { type: "set-use-worktree"; value: boolean }
  | { type: "set-start-at"; value: string }
  | { type: "set-start-at-default"; value: string }
  | { type: "set-interval-value"; value: number }
  | { type: "set-interval-unit"; value: AutomationFormIntervalUnit };

interface CreateInitialDraftOptions {
  automation: Automation | null;
  initialWorkspace: Workspace | null;
}

function formatDateTimeLocalInTimezone(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts["year"]}-${parts["month"]}-${parts["day"]}T${parts["hour"]}:${parts["minute"]}`;
}

function isModelKeyValid(models: ModelInfo[], modelKey: string): boolean {
  const parsedModel = parseModelKey(modelKey);
  if (!parsedModel) {
    return false;
  }
  const model = models.find((entry) =>
    entry.providerID === parsedModel.providerID
    && entry.modelID === parsedModel.modelID,
  );
  return Boolean(
    model?.connected
      && modelVariantExists(
        models,
        parsedModel.providerID,
        parsedModel.modelID,
        parsedModel.variant,
      ),
  );
}

function getDefaultModelKey(models: ModelInfo[], lastModel: ModelConfig | null): string {
  if (lastModel) {
    const lastModelKey = makeModelKey(lastModel.providerID, lastModel.modelID, lastModel.variant);
    if (isModelKeyValid(models, lastModelKey)) {
      return lastModelKey;
    }
  }
  const connected = models.find((model) => model.connected);
  return connected ? makeModelKey(connected.providerID, connected.modelID, connected.variants?.[0] ?? "") : "";
}

function createInitialDraft({
  automation,
  initialWorkspace,
}: CreateInitialDraftOptions): AutomationFormDraft {
  return {
    name: automation?.config.name ?? "",
    prompt: automation?.config.prompt ?? "",
    workspaceId: automation?.config.workspaceId ?? initialWorkspace?.id ?? "",
    modelKey: automation
      ? makeModelKey(automation.config.model.providerID, automation.config.model.modelID, automation.config.model.variant)
      : "",
    baseBranch: automation?.config.baseBranch ?? "",
    useWorktree: automation?.config.useWorktree ?? true,
    startAtLocal: automation?.config.schedule.startAtLocal ?? "",
    startAtTouched: Boolean(automation),
    intervalValue: automation?.config.schedule.interval.value ?? 60,
    intervalUnit: automation?.config.schedule.interval.unit ?? "minutes",
  };
}

function automationFormReducer(state: AutomationFormDraft, action: AutomationFormAction): AutomationFormDraft {
  switch (action.type) {
    case "set-name":
      return { ...state, name: action.value };
    case "set-prompt":
      return { ...state, prompt: action.value };
    case "set-workspace-id":
      return state.workspaceId === action.value
        ? state
        : {
            ...state,
            workspaceId: action.value,
            modelKey: "",
            baseBranch: "",
          };
    case "set-model-key":
      return { ...state, modelKey: action.value };
    case "set-base-branch":
      return { ...state, baseBranch: action.value };
    case "set-use-worktree":
      return { ...state, useWorktree: action.value };
    case "set-start-at":
      return { ...state, startAtLocal: action.value, startAtTouched: true };
    case "set-start-at-default":
      return { ...state, startAtLocal: action.value };
    case "set-interval-value":
      return { ...state, intervalValue: action.value };
    case "set-interval-unit":
      return { ...state, intervalUnit: action.value };
  }
}

export interface UseAutomationFormStateOptions {
  mode: AutomationFormMode;
  automation: Automation | null;
  initialWorkspace: Workspace | null;
  workspaces: Workspace[];
  workspacesLoading: boolean;
  models: ModelInfo[];
  modelsLoading: boolean;
  modelsWorkspaceId: string | null;
  lastModel: ModelConfig | null;
  branches: BranchInfo[];
  branchesLoading: boolean;
  branchesWorkspaceId: string | null;
  currentBranch: string;
  defaultBranch: string;
  onWorkspaceChange: (
    workspaceId: string | null,
    directory: string,
    workspaceType?: Workspace["workspaceType"],
  ) => void;
  onCreateAutomation: UseAutomationsResult["createAutomation"];
  onUpdateAutomation: UseAutomationsResult["updateAutomation"];
  onSaved: (automation: Automation) => void;
}

export interface UseAutomationFormStateResult {
  draft: AutomationFormDraft;
  selectedWorkspace: Workspace | null;
  isSubmitting: boolean;
  canSubmit: boolean;
  workspaceSelectionsReady: boolean;
  worktreeControlDisabled: boolean;
  worktreeForNewRun: boolean;
  schedulerTimezone: string | null;
  schedulerError: Error | null;
  refreshScheduler: () => Promise<void>;
  setName: (value: string) => void;
  setPrompt: (value: string) => void;
  setWorkspaceId: (value: string) => void;
  setModelKey: (value: string) => void;
  setBaseBranch: (value: string) => void;
  setUseWorktree: (value: boolean) => void;
  setStartAtLocal: (value: string) => void;
  setIntervalValue: (value: number) => void;
  setIntervalUnit: (value: AutomationFormIntervalUnit) => void;
  submit: (code: string) => Promise<void>;
}

export function useAutomationFormState({
  mode,
  automation,
  initialWorkspace,
  workspaces,
  workspacesLoading,
  models,
  modelsLoading,
  modelsWorkspaceId,
  lastModel,
  branches,
  branchesLoading,
  branchesWorkspaceId,
  currentBranch,
  defaultBranch,
  onWorkspaceChange,
  onCreateAutomation,
  onUpdateAutomation,
  onSaved,
}: UseAutomationFormStateOptions): UseAutomationFormStateResult {
  const toast = useToast();
  const toastError = toast.error;
  const [draft, dispatch] = useReducer(
    automationFormReducer,
    { automation, initialWorkspace },
    createInitialDraft,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const scheduling = useWorkspaceSchedulerTimezone(draft.workspaceId, automation?.config.schedule.timezone);
  const schedulerTimezone = scheduling.timezone;

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === draft.workspaceId) ?? null,
    [draft.workspaceId, workspaces],
  );

  useEffect(() => {
    if (mode === "create" && initialWorkspace && draft.workspaceId !== initialWorkspace.id) {
      dispatch({ type: "set-workspace-id", value: initialWorkspace.id });
    }
  }, [draft.workspaceId, initialWorkspace?.id, mode]);

  useEffect(() => {
    if (!selectedWorkspace) {
      onWorkspaceChange(null, "");
      return;
    }
    onWorkspaceChange(
      selectedWorkspace.id,
      selectedWorkspace.directory,
      selectedWorkspace.workspaceType,
    );
  }, [
    onWorkspaceChange,
    selectedWorkspace?.directory,
    selectedWorkspace?.id,
    selectedWorkspace?.workspaceType,
  ]);

  const modelsReady = Boolean(
    selectedWorkspace
      && modelsWorkspaceId === selectedWorkspace.id
      && !modelsLoading,
  );
  const gitBackedWorkspace = selectedWorkspace?.workspaceType === "git";
  const worktreesAllowed = gitBackedWorkspace && selectedWorkspace.allowWorktrees !== false;
  const preserveExistingWorktree = mode === "edit"
    && automation?.config.useWorktree === true
    && draft.useWorktree;
  const workspaceSelectionResolved = !workspacesLoading;
  const worktreeControlDisabled = workspaceSelectionResolved
    && !worktreesAllowed
    && !preserveExistingWorktree;
  const branchesReady = Boolean(
    selectedWorkspace
      && (!gitBackedWorkspace || (
        branchesWorkspaceId === selectedWorkspace.id
        && !branchesLoading
      )),
  );
  const modelSelectionValid = modelsReady && isModelKeyValid(models, draft.modelKey);
  const branchSelectionValid = !gitBackedWorkspace || (
    branchesReady
    && isWorkspaceBranchSelectionValid(draft.baseBranch, branches, currentBranch, defaultBranch)
  );
  const workspaceSelectionsReady = modelSelectionValid && branchSelectionValid;

  useEffect(() => {
    if (!workspaceSelectionResolved) {
      return;
    }
    if (!worktreeControlDisabled && worktreesAllowed) {
      return;
    }
    if (preserveExistingWorktree || !draft.useWorktree) {
      return;
    }
    dispatch({ type: "set-use-worktree", value: false });
  }, [
    draft.useWorktree,
    preserveExistingWorktree,
    worktreeControlDisabled,
    worktreesAllowed,
    workspaceSelectionResolved,
  ]);

  useEffect(() => {
    if (!gitBackedWorkspace || !branchesReady) {
      return;
    }
    const nextBranch = resolveWorkspaceBranchSelection(
      draft.baseBranch,
      branches,
      currentBranch,
      defaultBranch,
    );
    const normalizedBranch = draft.baseBranch.trim();
    if (normalizedBranch !== nextBranch) {
      dispatch({ type: "set-base-branch", value: nextBranch });
    }
  }, [branches, branchesReady, currentBranch, defaultBranch, draft.baseBranch]);

  useEffect(() => {
    if (!modelsReady || isModelKeyValid(models, draft.modelKey)) {
      return;
    }
    dispatch({ type: "set-model-key", value: getDefaultModelKey(models, lastModel) });
  }, [draft.modelKey, lastModel, models, modelsReady]);

  useEffect(() => {
    if (mode !== "create" || draft.startAtTouched || !schedulerTimezone) {
      return;
    }
    dispatch({
      type: "set-start-at-default",
      value: formatDateTimeLocalInTimezone(new Date(), schedulerTimezone),
    });
  }, [draft.startAtTouched, mode, schedulerTimezone]);

  const setName = useCallback((value: string) => {
    dispatch({ type: "set-name", value });
  }, []);
  const setPrompt = useCallback((value: string) => {
    dispatch({ type: "set-prompt", value });
  }, []);
  const setWorkspaceId = useCallback((value: string) => {
    dispatch({ type: "set-workspace-id", value });
  }, []);
  const setModelKey = useCallback((value: string) => {
    dispatch({ type: "set-model-key", value });
  }, []);
  const setBaseBranch = useCallback((value: string) => {
    dispatch({ type: "set-base-branch", value });
  }, []);
  const setUseWorktree = useCallback((value: boolean) => {
    dispatch({ type: "set-use-worktree", value });
  }, []);
  const setStartAtLocal = useCallback((value: string) => {
    dispatch({ type: "set-start-at", value });
  }, []);
  const setIntervalValue = useCallback((value: number) => {
    dispatch({ type: "set-interval-value", value });
  }, []);
  const setIntervalUnit = useCallback((value: AutomationFormIntervalUnit) => {
    dispatch({ type: "set-interval-unit", value });
  }, []);

  const canSubmit = !isSubmitting
    && Boolean(schedulerTimezone)
    && !scheduling.error
    && workspaceSelectionsReady
    && Boolean(draft.name.trim())
    && Boolean(draft.prompt.trim())
    && Boolean(draft.startAtLocal.trim())
    && Number.isInteger(draft.intervalValue)
    && draft.intervalValue >= 1;

  const submit = useCallback(async (code: string): Promise<void> => {
    if (!schedulerTimezone || scheduling.error) {
      toastError("Scheduling defaults are not available from the workspace controller.");
      return;
    }
    if (!selectedWorkspace) {
      toastError("Select a workspace first");
      return;
    }
    if (!modelsReady || !modelSelectionValid) {
      toastError("Select a valid model for the selected workspace");
      return;
    }
    if (!branchesReady || !branchSelectionValid) {
      toastError("Select a valid base branch for the selected workspace");
      return;
    }
    if (
      !draft.name.trim()
      || !draft.prompt.trim()
      || !draft.startAtLocal.trim()
      || !Number.isInteger(draft.intervalValue)
      || draft.intervalValue < 1
    ) {
      toastError("Complete the automation name, prompt, and schedule");
      return;
    }
    const parsedModel = parseModelKey(draft.modelKey);
    if (!parsedModel) {
      toastError("Select a model first");
      return;
    }
    const schedule = {
      startAtLocal: draft.startAtLocal,
      timezone: schedulerTimezone,
      interval: {
        value: draft.intervalValue,
        unit: draft.intervalUnit,
      },
    };
    const baseRequest: Omit<CreateAutomationRequest, "workspaceId" | "enabled"> = {
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      code: code.trim() || null,
      model: {
        providerID: parsedModel.providerID,
        modelID: parsedModel.modelID,
        variant: parsedModel.variant ?? "",
      },
      ...(gitBackedWorkspace
        ? {
            baseBranch: draft.baseBranch.trim() || undefined,
            useWorktree: worktreesAllowed || preserveExistingWorktree ? draft.useWorktree : false,
          }
        : {
            useWorktree: false,
          }),
      schedule,
    };

    setIsSubmitting(true);
    try {
      const savedAutomation = mode === "edit" && automation
        ? await onUpdateAutomation(automation.config.id, gitBackedWorkspace
          ? {
              ...baseRequest,
              baseBranch: baseRequest.baseBranch ?? null,
            } satisfies UpdateAutomationRequest
          : baseRequest satisfies UpdateAutomationRequest)
        : await onCreateAutomation({
            ...baseRequest,
            workspaceId: selectedWorkspace.id,
            enabled: true,
          } satisfies CreateAutomationRequest);
      if (!savedAutomation) {
        toastError(mode === "edit" ? "Failed to save automation" : "Failed to create automation");
        return;
      }
      onSaved(savedAutomation);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    automation,
    branchSelectionValid,
    branchesReady,
    draft,
    gitBackedWorkspace,
    modelSelectionValid,
    modelsReady,
    mode,
    onCreateAutomation,
    onSaved,
    onUpdateAutomation,
    schedulerTimezone,
    scheduling.error,
    selectedWorkspace,
    toastError,
    preserveExistingWorktree,
    worktreesAllowed,
  ]);

  return {
    draft,
    selectedWorkspace,
    isSubmitting,
    canSubmit,
    workspaceSelectionsReady,
    worktreeControlDisabled,
    worktreeForNewRun: draft.useWorktree,
    schedulerTimezone,
    schedulerError: scheduling.error,
    refreshScheduler: scheduling.refresh,
    setName,
    setPrompt,
    setWorkspaceId,
    setModelKey,
    setBaseBranch,
    setUseWorktree,
    setStartAtLocal,
    setIntervalValue,
    setIntervalUnit,
    submit,
  };
}
