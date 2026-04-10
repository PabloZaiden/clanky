/**
 * CreateLoopForm component for creating new Ralph Loops.
 */

import { useState } from "react";
import { WorkspaceSelector } from "../WorkspaceSelector";
import {
  type CreateLoopFormActionState,
  type CreateLoopFormProps,
  type CreateLoopFormSubmitRequest,
  getComposeDraftActionLabel,
  getComposeSubmitActionLabel,
} from "./types";
import { BranchSelector } from "./branch-selector";
import { ModelField } from "./model-field";
import { TemplateSelector } from "./template-selector";
import { TitleField } from "./title-field";
import { PromptField } from "./prompt-field";
import { LoopSettings } from "./loop-settings";
import { AdvancedOptions } from "./advanced-options";
import { FormActions } from "./form-actions";
import { useCreateLoopForm } from "./use-create-loop-form";
import type { ComposerImageAttachment } from "../../types/message-attachments";

export type { CreateLoopFormActionState, CreateLoopFormProps, CreateLoopFormSubmitRequest };
export { getComposeDraftActionLabel, getComposeSubmitActionLabel };

export function CreateLoopForm({
  onSubmit,
  onCancel,
  closeOnSuccess = true,
  loading = false,
  models = [],
  modelsLoading = false,
  lastModel,
  onWorkspaceChange,
  planningWarning,
  branches = [],
  branchesLoading = false,
  currentBranch = "",
  defaultBranch = "",
  editLoopId = null,
  initialLoopData = null,
  isEditingDraft = false,
  workspaces = [],
  workspacesLoading = false,
  workspaceError = null,
  renderActions,
  leadingActions,
}: CreateLoopFormProps) {
  const [attachments, setAttachments] = useState<ComposerImageAttachment[]>([]);
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
    selectedBranch,
    setSelectedBranch,
    setUserChangedBranch,
    selectedTemplate,
    setSelectedTemplate,
    planMode,
    setPlanMode,
    planModeAutoReply,
    setPlanModeAutoReply,
    autoAcceptPlan,
    setAutoAcceptPlan,
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
  } = useCreateLoopForm({
    onSubmit,
    onCancel,
    closeOnSuccess,
    loading,
    models,
    lastModel,
    onWorkspaceChange,
    currentBranch,
    defaultBranch,
    editLoopId,
    initialLoopData,
    isEditingDraft,
    attachments,
    renderActions,
  });

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
      />

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

      <TitleField
        name={name}
        onChange={(value) => {
          setName(value);
          nameRef.current = value;
        }}
        onGenerate={() => void handleGenerateTitle()}
        canGenerate={canGenerateTitle}
        generating={generatingTitle}
      />

      {/* Prompt */}
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
        selectedTemplate={selectedTemplate}
        onTemplateClear={() => setSelectedTemplate("")}
      />

      <LoopSettings
        planMode={planMode}
        onPlanModeChange={setPlanMode}
        planModeAutoReply={planModeAutoReply}
        onPlanModeAutoReplyChange={setPlanModeAutoReply}
        autoAcceptPlan={autoAcceptPlan}
        onAutoAcceptPlanChange={setAutoAcceptPlan}
        useWorktree={useWorktree}
        onUseWorktreeChange={setUseWorktree}
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

export default CreateLoopForm;
