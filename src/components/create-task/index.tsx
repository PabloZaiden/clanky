/**
 * CreateTaskForm component for creating new Clanky Tasks.
 */

import { useEffect, useState } from "react";
import { WorkspaceSelector } from "../WorkspaceSelector";
import {
  type CreateTaskFormActionState,
  type CreateTaskFormProps,
  getComposeDraftActionLabel,
  getComposeSubmitActionLabel,
} from "./types";
import { BranchSelector } from "./branch-selector";
import { ModelField } from "./model-field";
import { TemplateSelector } from "./template-selector";
import { TitleField } from "./title-field";
import { PromptField } from "./prompt-field";
import { TaskSettings } from "./task-settings";
import { AdvancedOptions } from "./advanced-options";
import { FormActions } from "./form-actions";
import { UploadedPlanField } from "./uploaded-plan-field";
import { useCreateTaskForm } from "./use-create-task-form";
import { UPLOADED_PLAN_IMPLEMENTATION_PROMPT } from "../../lib/uploaded-plan";
import type { ComposerImageAttachment } from "../../types/message-attachments";
import type { CreateTaskFormSubmitRequest } from "../../types/task-request";
import type { UploadedPlanFile } from "./types";

export type { CreateTaskFormActionState, CreateTaskFormProps, CreateTaskFormSubmitRequest };
export { getComposeDraftActionLabel, getComposeSubmitActionLabel };

export function CreateTaskForm({
  onSubmit,
  onCancel,
  closeOnSuccess = true,
  loading = false,
  models = [],
  modelsLoading = false,
  lastModel,
  lastCheapModel,
  onWorkspaceChange,
  planningWarning,
  branches = [],
  branchesLoading = false,
  currentBranch = "",
  defaultBranch = "",
  editTaskId = null,
  initialTaskData = null,
  isEditingDraft = false,
  workspaces = [],
  workspacesLoading = false,
  workspaceError = null,
  renderActions,
  leadingActions,
}: CreateTaskFormProps) {
  const [attachments, setAttachments] = useState<ComposerImageAttachment[]>([]);
  const [uploadedPlan, setUploadedPlan] = useState<UploadedPlanFile | null>(null);
  const [uploadedPlanError, setUploadedPlanError] = useState<string | null>(null);
  const {
    formRef,
    promptRef,
    nameRef,
    isEditing,
    isSubmitting,
    canSubmit,
    canSaveDraft,
    canGenerateTitle,
    selectedWorkspaceId,
    handleWorkspaceSelect,
    name,
    setName,
    prompt,
    setPrompt,
    selectedModel,
    setSelectedModel,
    selectedCheapModel,
    setSelectedCheapModel,
    selectedBranch,
    setSelectedBranch,
    setUserChangedBranch,
    selectedTemplate,
    setSelectedTemplate,
    planMode,
    setPlanMode,
    autoAcceptPlan,
    setAutoAcceptPlan,
    fullyAutonomous,
    setFullyAutonomous,
    useWorktree,
    setUseWorktree,
    clearPlanningFolder,
    setClearPlanningFolder,
    showAdvanced,
    setShowAdvanced,
    maxIterations,
    setMaxIterations,
    maxConsecutiveErrors,
    setMaxConsecutiveErrors,
    activityTimeoutSeconds,
    setActivityTimeoutSeconds,
    generatingTitle,
    handleSubmit,
    handleGenerateTitle,
  } = useCreateTaskForm({
    onSubmit,
    onCancel,
    closeOnSuccess,
     loading,
     models,
     lastModel,
     lastCheapModel,
     onWorkspaceChange,
    currentBranch,
    defaultBranch,
    editTaskId,
    initialTaskData,
    isEditingDraft,
    attachments,
    renderActions,
    uploadedPlan,
  });
  const selectedWorkspace = workspaces.find((workspace) => workspace.id === selectedWorkspaceId);
  const uploadedPlanLocked = !!uploadedPlan;

  useEffect(() => {
    if (!uploadedPlan) {
      return;
    }
    setPlanMode(true);
    setAutoAcceptPlan(true);
    setSelectedTemplate("");
    setAttachments([]);
  }, [setAutoAcceptPlan, setPlanMode, setSelectedTemplate, uploadedPlan]);

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-3 sm:space-y-4">
      {/* Workspace Selection */}
      <div>
        <WorkspaceSelector
          workspaces={workspaces}
          loading={workspacesLoading}
          selectedWorkspaceId={selectedWorkspaceId}
          onSelect={handleWorkspaceSelect}
          error={workspaceError}
          showServerDetails={false}
        />
        {planningWarning && !planMode && (
          <div className="mt-2 flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-300">
            <svg
              className="h-5 w-5 flex-shrink-0 text-amber-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <span>{planningWarning}</span>
          </div>
        )}
      </div>

      {/* Base Branch Selection */}
      <BranchSelector
        selectedBranch={selectedBranch}
        onBranchChange={(branch) => {
          setSelectedBranch(branch);
          setUserChangedBranch(true);
        }}
        branches={branches}
        branchesLoading={branchesLoading}
        defaultBranch={defaultBranch}
        currentBranch={currentBranch}
      />

      {/* Model Selection */}
      <ModelField
        selectedModel={selectedModel}
        onChange={setSelectedModel}
        models={models}
        modelsLoading={modelsLoading}
        variantDiscovery={selectedWorkspace ? {
          directory: selectedWorkspace.directory,
          workspaceId: selectedWorkspace.id,
        } : undefined}
      />

      {!uploadedPlan && (
        <TemplateSelector
          selectedTemplate={selectedTemplate}
          onChange={setSelectedTemplate}
          onPromptChange={(p) => {
            setPrompt(p);
            promptRef.current = p;
          }}
          onPlanModeChange={setPlanMode}
          promptRef={promptRef}
        />
      )}

      <TitleField
        name={name}
        onChange={(value) => {
          setName(value);
          nameRef.current = value;
        }}
        onGenerate={() => void handleGenerateTitle()}
        canGenerate={canGenerateTitle}
        generating={generatingTitle}
        required={isEditing || isEditingDraft}
      />

      {uploadedPlan ? (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900/50 dark:bg-emerald-900/20 dark:text-emerald-200">
          <p className="font-medium">Prompt that will be sent to the agent</p>
          <p className="mt-1">{UPLOADED_PLAN_IMPLEMENTATION_PROMPT}</p>
        </div>
      ) : (
        <PromptField
          prompt={prompt}
          onChange={(value) => {
            setPrompt(value);
            promptRef.current = value;
          }}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          planMode={planMode}
          isEditingDraft={isEditingDraft}
          showClipboardPaste={!isEditing && !isEditingDraft}
          selectedTemplate={selectedTemplate}
          onTemplateClear={() => setSelectedTemplate("")}
        />
      )}

      <UploadedPlanField
        uploadedPlan={uploadedPlan}
        error={uploadedPlanError}
        onUploadedPlanChange={setUploadedPlan}
        onErrorChange={setUploadedPlanError}
        disabled={isEditingDraft || isEditing}
      />

      <TaskSettings
        planMode={planMode}
        onPlanModeChange={setPlanMode}
        autoAcceptPlan={autoAcceptPlan}
        onAutoAcceptPlanChange={setAutoAcceptPlan}
        fullyAutonomous={fullyAutonomous}
        onFullyAutonomousChange={setFullyAutonomous}
        useWorktree={useWorktree}
        onUseWorktreeChange={setUseWorktree}
        uploadedPlanLocked={uploadedPlanLocked}
      />

      <AdvancedOptions
        showAdvanced={showAdvanced}
        onToggle={() => setShowAdvanced(!showAdvanced)}
        maxIterations={maxIterations}
        onMaxIterationsChange={setMaxIterations}
        maxConsecutiveErrors={maxConsecutiveErrors}
        onMaxConsecutiveErrorsChange={setMaxConsecutiveErrors}
        activityTimeoutSeconds={activityTimeoutSeconds}
        onActivityTimeoutChange={setActivityTimeoutSeconds}
        clearPlanningFolder={clearPlanningFolder}
        onClearPlanningFolderChange={setClearPlanningFolder}
        selectedCheapModel={selectedCheapModel}
        onCheapModelChange={setSelectedCheapModel}
        models={models}
        modelsLoading={modelsLoading}
        variantDiscovery={selectedWorkspace ? {
          directory: selectedWorkspace.directory,
          workspaceId: selectedWorkspace.id,
        } : undefined}
      />

      {/* Actions - only render inline if renderActions prop is not provided */}
      {!renderActions && (
        <FormActions
          isEditing={isEditing}
          isEditingDraft={isEditingDraft}
          isSubmitting={isSubmitting}
          canSubmit={canSubmit}
          canSaveDraft={canSaveDraft}
          onCancel={onCancel}
          onSaveAsDraft={(e) => void handleSubmit(e, true)}
          leadingActions={leadingActions}
        />
      )}
    </form>
  );
}

export default CreateTaskForm;
