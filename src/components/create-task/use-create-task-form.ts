/**
 * useCreateTaskForm — state management hook for CreateTaskForm.
 *
 * Thin compositor that delegates to focused sub-hooks and assembles the
 * combined return value for the form component renderer.
 */

import type { FormEvent } from "react";
import { isModelEnabled } from "../ModelSelector";
import type { CreateTaskFormProps } from "./types";
import { useFormFields } from "./use-form-fields";
import { useWorkspaceSelection } from "./use-workspace-selection";
import { useModelSelection } from "./use-model-selection";
import { useFormActions } from "./use-form-actions";
import { useTitleGeneration } from "./use-title-generation";

export interface UseCreateTaskFormReturn {
  // Refs
  formRef: React.RefObject<HTMLFormElement | null>;
  nameRef: React.MutableRefObject<string>;
  promptRef: React.MutableRefObject<string>;

  // Derived flags
  isEditing: boolean;
  isSubmitting: boolean;
  canSubmit: boolean;
  canSaveDraft: boolean;
  canGenerateTitle: boolean;

  // Workspace
  selectedWorkspaceId: string | undefined;
  selectedWorkspaceDirectory: string;
  handleWorkspaceSelect: (workspaceId: string | null, workspaceDirectory: string) => void;

  // Fields
  name: string;
  setName: (v: string) => void;
  prompt: string;
  setPrompt: (v: string) => void;
  selectedModel: string;
  setSelectedModel: (v: string) => void;
  selectedCheapModel: string;
  setSelectedCheapModel: (v: string) => void;
  selectedBranch: string;
  setSelectedBranch: (v: string) => void;
  setUserChangedBranch: (v: boolean) => void;
  selectedTemplate: string;
  setSelectedTemplate: (v: string) => void;
  planMode: boolean;
  setPlanMode: (v: boolean) => void;
  autoAcceptPlan: boolean;
  setAutoAcceptPlan: (v: boolean) => void;
  fullyAutonomous: boolean;
  setFullyAutonomous: (v: boolean) => void;
  useWorktree: boolean;
  setUseWorktree: (v: boolean) => void;
  clearPlanningFolder: boolean;
  setClearPlanningFolder: (v: boolean) => void;
  showAdvanced: boolean;
  setShowAdvanced: (v: boolean) => void;
  maxIterations: string;
  setMaxIterations: (v: string) => void;
  maxConsecutiveErrors: string;
  setMaxConsecutiveErrors: (v: string) => void;
  activityTimeoutSeconds: string;
  setActivityTimeoutSeconds: (v: string) => void;
  generatingTitle: boolean;

  // Handlers
  handleSubmit: (e: FormEvent, asDraft?: boolean) => Promise<void>;
  handleGenerateTitle: () => Promise<void>;
  handleExternalCancel: () => void;
  handleExternalSubmit: () => void;
  handleExternalSaveAsDraft: () => void;
}

export function useCreateTaskForm({
  onSubmit,
  onCancel,
  closeOnSuccess = true,
  loading = false,
  models = [],
  lastModel,
  lastCheapModel,
  onWorkspaceChange,
  currentBranch = "",
  defaultBranch = "",
  editTaskId = null,
  initialTaskData = null,
  isEditingDraft = false,
  attachments = [],
  renderActions,
}: Pick<
  CreateTaskFormProps,
  | "onSubmit"
  | "onCancel"
  | "closeOnSuccess"
  | "loading"
  | "models"
  | "lastModel"
  | "lastCheapModel"
  | "onWorkspaceChange"
  | "currentBranch"
  | "defaultBranch"
  | "editTaskId"
  | "initialTaskData"
  | "isEditingDraft"
  | "attachments"
  | "renderActions"
>): UseCreateTaskFormReturn {
  const isEditing = !!editTaskId;

  const fields = useFormFields({ initialTaskData });

  const workspace = useWorkspaceSelection({
    isEditing,
    initialTaskData,
    onWorkspaceChange,
    defaultBranch,
  });

  const {
    selectedModel,
    setSelectedModel,
    selectedCheapModel,
    setSelectedCheapModel,
  } = useModelSelection({
    models,
    lastModel,
    lastCheapModel,
    initialTaskData,
  });

  const selectedModelEnabled = selectedModel ? isModelEnabled(models, selectedModel) : false;

  const { generatingTitle, generateTitle, handleGenerateTitle } = useTitleGeneration({
    selectedWorkspaceId: workspace.selectedWorkspaceId,
    selectedModel,
    selectedCheapModel,
    nameRef: fields.nameRef,
    promptRef: fields.promptRef,
    setName: fields.setName,
  });

  const actions = useFormActions({
    selectedWorkspaceId: workspace.selectedWorkspaceId,
    selectedModel,
    selectedCheapModel,
    selectedModelEnabled,
      planMode: fields.planMode,
      autoAcceptPlan: fields.autoAcceptPlan,
      fullyAutonomous: fields.fullyAutonomous,
    maxIterations: fields.maxIterations,
    maxConsecutiveErrors: fields.maxConsecutiveErrors,
    activityTimeoutSeconds: fields.activityTimeoutSeconds,
    selectedBranch: workspace.selectedBranch,
    currentBranch,
    clearPlanningFolder: fields.clearPlanningFolder,
    useWorktree: fields.useWorktree,
    nameRef: fields.nameRef,
    promptRef: fields.promptRef,
    onSubmit,
    onCancel,
    closeOnSuccess,
    loading,
    isEditing,
    isEditingDraft,
    renderActions,
    generatingTitle,
    generateTitle,
    prompt: fields.prompt,
    name: fields.name,
    attachments,
  });

  return {
    formRef: actions.formRef,
    nameRef: fields.nameRef,
    promptRef: fields.promptRef,
    isEditing,
    isSubmitting: actions.isSubmitting,
    canSubmit: actions.canSubmit,
    canSaveDraft: actions.canSaveDraft,
    canGenerateTitle: actions.canGenerateTitle,
    selectedWorkspaceId: workspace.selectedWorkspaceId,
    selectedWorkspaceDirectory: workspace.selectedWorkspaceDirectory,
    handleWorkspaceSelect: workspace.handleWorkspaceSelect,
    name: fields.name,
    setName: fields.setName,
    prompt: fields.prompt,
    setPrompt: fields.setPrompt,
    selectedModel,
    setSelectedModel,
    selectedCheapModel,
    setSelectedCheapModel,
    selectedBranch: workspace.selectedBranch,
    setSelectedBranch: workspace.setSelectedBranch,
    setUserChangedBranch: workspace.setUserChangedBranch,
    selectedTemplate: fields.selectedTemplate,
    setSelectedTemplate: fields.setSelectedTemplate,
    planMode: fields.planMode,
    setPlanMode: fields.setPlanMode,
    autoAcceptPlan: fields.autoAcceptPlan,
    setAutoAcceptPlan: fields.setAutoAcceptPlan,
    fullyAutonomous: fields.fullyAutonomous,
    setFullyAutonomous: fields.setFullyAutonomous,
    useWorktree: fields.useWorktree,
    setUseWorktree: fields.setUseWorktree,
    clearPlanningFolder: fields.clearPlanningFolder,
    setClearPlanningFolder: fields.setClearPlanningFolder,
    showAdvanced: fields.showAdvanced,
    setShowAdvanced: fields.setShowAdvanced,
    maxIterations: fields.maxIterations,
    setMaxIterations: fields.setMaxIterations,
    maxConsecutiveErrors: fields.maxConsecutiveErrors,
    setMaxConsecutiveErrors: fields.setMaxConsecutiveErrors,
    activityTimeoutSeconds: fields.activityTimeoutSeconds,
    setActivityTimeoutSeconds: fields.setActivityTimeoutSeconds,
    generatingTitle,
    handleSubmit: actions.handleSubmit,
    handleGenerateTitle,
    handleExternalCancel: actions.handleExternalCancel,
    handleExternalSubmit: actions.handleExternalSubmit,
    handleExternalSaveAsDraft: actions.handleExternalSaveAsDraft,
  };
}
