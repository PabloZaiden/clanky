import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import type { BranchInfo, ModelInfo } from "@/contracts";
import type { Agent, ModelConfig, Workspace } from "@/shared";
import type { CreateAgentRequest, UpdateAgentRequest } from "@/contracts/schemas";
import { useToast } from "@pablozaiden/webapp/web";
import { makeModelKey, modelVariantExists, parseModelKey } from "../ModelSelector";
import type { UseAgentsResult } from "../../hooks/useAgents";

export type AgentFormMode = "create" | "edit";
export type AgentFormIntervalUnit = "minutes" | "hours" | "days";

export interface AgentFormDraft {
  name: string;
  prompt: string;
  workspaceId: string;
  modelKey: string;
  baseBranch: string;
  useWorktree: boolean;
  startAtLocal: string;
  startAtTouched: boolean;
  intervalValue: number;
  intervalUnit: AgentFormIntervalUnit;
}

type AgentFormAction =
  | { type: "set-name"; value: string }
  | { type: "set-prompt"; value: string }
  | { type: "set-workspace-id"; value: string }
  | { type: "set-model-key"; value: string }
  | { type: "set-base-branch"; value: string }
  | { type: "set-use-worktree"; value: boolean }
  | { type: "set-start-at"; value: string }
  | { type: "set-start-at-default"; value: string }
  | { type: "set-interval-value"; value: number }
  | { type: "set-interval-unit"; value: AgentFormIntervalUnit };

interface CreateInitialDraftOptions {
  agent: Agent | null;
  initialWorkspace: Workspace | null;
  schedulerTimezone: string;
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

function getBranchOptions(
  branches: { name: string }[],
  currentBranch: string,
  defaultBranch: string,
): Set<string> {
  return new Set([
    ...branches.map((branch) => branch.name),
    currentBranch,
    defaultBranch,
  ].filter(Boolean));
}

function isBranchSelectionValid(
  baseBranch: string,
  branches: { name: string }[],
  currentBranch: string,
  defaultBranch: string,
): boolean {
  const normalizedBranch = baseBranch.trim();
  return normalizedBranch === ""
    || getBranchOptions(branches, currentBranch, defaultBranch).has(normalizedBranch);
}

function createInitialDraft({
  agent,
  initialWorkspace,
  schedulerTimezone,
}: CreateInitialDraftOptions): AgentFormDraft {
  return {
    name: agent?.config.name ?? "",
    prompt: agent?.config.prompt ?? "",
    workspaceId: agent?.config.workspaceId ?? initialWorkspace?.id ?? "",
    modelKey: agent
      ? makeModelKey(agent.config.model.providerID, agent.config.model.modelID, agent.config.model.variant)
      : "",
    baseBranch: agent?.config.baseBranch ?? "",
    useWorktree: agent?.config.useWorktree ?? true,
    startAtLocal: agent?.config.schedule.startAtLocal
      ?? formatDateTimeLocalInTimezone(new Date(), schedulerTimezone),
    startAtTouched: Boolean(agent),
    intervalValue: agent?.config.schedule.interval.value ?? 60,
    intervalUnit: agent?.config.schedule.interval.unit ?? "minutes",
  };
}

function agentFormReducer(state: AgentFormDraft, action: AgentFormAction): AgentFormDraft {
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

export interface UseAgentFormStateOptions {
  mode: AgentFormMode;
  agent: Agent | null;
  initialWorkspace: Workspace | null;
  workspaces: Workspace[];
  models: ModelInfo[];
  modelsLoading: boolean;
  modelsWorkspaceId: string | null;
  lastModel: ModelConfig | null;
  schedulerTimezone: string;
  branches: BranchInfo[];
  branchesLoading: boolean;
  branchesWorkspaceId: string | null;
  currentBranch: string;
  defaultBranch: string;
  onWorkspaceChange: (workspaceId: string | null, directory: string) => void;
  onCreateAgent: UseAgentsResult["createAgent"];
  onUpdateAgent: UseAgentsResult["updateAgent"];
  onSaved: (agent: Agent) => void;
}

export interface UseAgentFormStateResult {
  draft: AgentFormDraft;
  selectedWorkspace: Workspace | null;
  isSubmitting: boolean;
  canSubmit: boolean;
  workspaceSelectionsReady: boolean;
  setName: (value: string) => void;
  setPrompt: (value: string) => void;
  setWorkspaceId: (value: string) => void;
  setModelKey: (value: string) => void;
  setBaseBranch: (value: string) => void;
  setUseWorktree: (value: boolean) => void;
  setStartAtLocal: (value: string) => void;
  setIntervalValue: (value: number) => void;
  setIntervalUnit: (value: AgentFormIntervalUnit) => void;
  submit: (code: string) => Promise<void>;
}

export function useAgentFormState({
  mode,
  agent,
  initialWorkspace,
  workspaces,
  models,
  modelsLoading,
  modelsWorkspaceId,
  lastModel,
  schedulerTimezone,
  branches,
  branchesLoading,
  branchesWorkspaceId,
  currentBranch,
  defaultBranch,
  onWorkspaceChange,
  onCreateAgent,
  onUpdateAgent,
  onSaved,
}: UseAgentFormStateOptions): UseAgentFormStateResult {
  const toast = useToast();
  const toastError = toast.error;
  const [draft, dispatch] = useReducer(
    agentFormReducer,
    { agent, initialWorkspace, schedulerTimezone },
    createInitialDraft,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

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
    onWorkspaceChange(selectedWorkspace.id, selectedWorkspace.directory);
  }, [onWorkspaceChange, selectedWorkspace?.directory, selectedWorkspace?.id]);

  const modelsReady = Boolean(
    selectedWorkspace
      && modelsWorkspaceId === selectedWorkspace.id
      && !modelsLoading,
  );
  const branchesReady = Boolean(
    selectedWorkspace
      && branchesWorkspaceId === selectedWorkspace.id
      && !branchesLoading,
  );
  const modelSelectionValid = modelsReady && isModelKeyValid(models, draft.modelKey);
  const branchSelectionValid = branchesReady
    && isBranchSelectionValid(draft.baseBranch, branches, currentBranch, defaultBranch);
  const workspaceSelectionsReady = modelSelectionValid && branchSelectionValid;

  useEffect(() => {
    if (!branchesReady) {
      return;
    }
    const normalizedBranch = draft.baseBranch.trim();
    if (normalizedBranch && isBranchSelectionValid(normalizedBranch, branches, currentBranch, defaultBranch)) {
      return;
    }
    const nextBranch = defaultBranch || currentBranch;
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
    if (mode !== "create" || draft.startAtTouched) {
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
  const setIntervalUnit = useCallback((value: AgentFormIntervalUnit) => {
    dispatch({ type: "set-interval-unit", value });
  }, []);

  const canSubmit = !isSubmitting
    && workspaceSelectionsReady
    && Boolean(draft.name.trim())
    && Boolean(draft.prompt.trim())
    && Boolean(draft.startAtLocal.trim())
    && Number.isInteger(draft.intervalValue)
    && draft.intervalValue >= 1;

  const submit = useCallback(async (code: string): Promise<void> => {
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
      toastError("Complete the agent name, prompt, and schedule");
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
    const baseRequest = {
      name: draft.name.trim(),
      prompt: draft.prompt.trim(),
      code: code.trim() || null,
      model: {
        providerID: parsedModel.providerID,
        modelID: parsedModel.modelID,
        variant: parsedModel.variant ?? "",
      },
      baseBranch: draft.baseBranch.trim() || undefined,
      useWorktree: draft.useWorktree,
      schedule,
    };

    setIsSubmitting(true);
    try {
      const savedAgent = mode === "edit" && agent
        ? await onUpdateAgent(agent.config.id, {
            ...baseRequest,
            baseBranch: baseRequest.baseBranch ?? null,
          } satisfies UpdateAgentRequest)
        : await onCreateAgent({
            ...baseRequest,
            workspaceId: selectedWorkspace.id,
            enabled: true,
          } satisfies CreateAgentRequest);
      if (!savedAgent) {
        toastError(mode === "edit" ? "Failed to save agent" : "Failed to create agent");
        return;
      }
      onSaved(savedAgent);
    } finally {
      setIsSubmitting(false);
    }
  }, [
    agent,
    branchSelectionValid,
    branchesReady,
    draft,
    modelSelectionValid,
    modelsReady,
    mode,
    onCreateAgent,
    onSaved,
    onUpdateAgent,
    schedulerTimezone,
    selectedWorkspace,
    toastError,
  ]);

  return {
    draft,
    selectedWorkspace,
    isSubmitting,
    canSubmit,
    workspaceSelectionsReady,
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
