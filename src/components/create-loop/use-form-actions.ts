/**
 * useFormActions — manages form submission, formRef, external action refs,
 * and the renderActions notification effect.
 */

import { useState, useRef, useEffect, useCallback, type FormEvent } from "react";
import type { ComposerImageAttachment } from "../../types/message-attachments";
import { parseModelKey } from "../ModelSelector";
import { createLogger } from "../../lib/logger";
import type { CreateLoopFormProps, CreateLoopFormSubmitRequest } from "./types";
import { toMessageImageAttachments } from "../../lib/image-attachments";
import { cheapModelValueToSelection } from "./use-model-selection";

const log = createLogger("CreateLoopForm");

export interface UseFormActionsReturn {
  formRef: React.RefObject<HTMLFormElement | null>;
  isSubmitting: boolean;
  canSubmit: boolean;
  canSaveDraft: boolean;
  canGenerateTitle: boolean;
  handleSubmit: (e: FormEvent, asDraft?: boolean) => Promise<void>;
  handleExternalCancel: () => void;
  handleExternalSubmit: () => void;
  handleExternalSaveAsDraft: () => void;
}

export function useFormActions({
  selectedWorkspaceId,
  selectedModel,
  selectedCheapModel,
  selectedModelEnabled,
  planMode,
  autoAcceptPlan,
  fullyAutonomous,
  maxIterations,
  maxConsecutiveErrors,
  activityTimeoutSeconds,
  selectedBranch,
  currentBranch,
  clearPlanningFolder,
  useWorktree,
  nameRef,
  promptRef,
  onSubmit,
  onCancel,
  closeOnSuccess,
  loading,
  isEditing,
  isEditingDraft,
  renderActions,
  generatingTitle,
  prompt,
  name,
  attachments,
}: {
  selectedWorkspaceId: string | undefined;
  selectedModel: string;
  selectedCheapModel: string;
  selectedModelEnabled: boolean;
  planMode: boolean;
  autoAcceptPlan: boolean;
  fullyAutonomous: boolean;
  maxIterations: string;
  maxConsecutiveErrors: string;
  activityTimeoutSeconds: string;
  selectedBranch: string;
  currentBranch: string;
  clearPlanningFolder: boolean;
  useWorktree: boolean;
  nameRef: React.MutableRefObject<string>;
  promptRef: React.MutableRefObject<string>;
  onSubmit: CreateLoopFormProps["onSubmit"];
  onCancel: CreateLoopFormProps["onCancel"];
  closeOnSuccess: boolean;
  loading: boolean;
  isEditing: boolean;
  isEditingDraft: boolean | undefined;
  renderActions: CreateLoopFormProps["renderActions"];
  generatingTitle: boolean;
  prompt: string;
  name: string;
  attachments: ComposerImageAttachment[];
}): UseFormActionsReturn {
  const [submitting, setSubmitting] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);

  const cancelActionRef = useRef(onCancel);
  const submitActionRef = useRef<() => void>(() => {});
  const saveAsDraftActionRef = useRef<() => void>(() => {});

  const isSubmitting = loading || submitting;

  const canSaveDraft = !!selectedWorkspaceId && !!prompt.trim() && !!name.trim();
  const canSubmit =
    !!selectedWorkspaceId &&
    !!prompt.trim() &&
    !!name.trim() &&
    selectedModelEnabled;
  const canGenerateTitle =
    !!selectedWorkspaceId && !!prompt.trim() && !isSubmitting && !generatingTitle;

  const handleSubmit = useCallback(
    async (e: FormEvent, asDraft = false) => {
      e.preventDefault();

      const currentName = nameRef.current;
      const currentPrompt = promptRef.current;

      log.info("Submitting create-loop form", {
        asDraft,
        hasPrompt: currentPrompt.trim().length > 0,
        hasName: currentName.trim().length > 0,
        selectedWorkspaceId,
      });

      if (!selectedWorkspaceId) return;
      if (!currentPrompt.trim()) return;
      if (!currentName.trim()) return;
      if (!selectedModel || !selectedModelEnabled) return;

      setSubmitting(true);

      const parsedModel = parseModelKey(selectedModel);
      if (!parsedModel) {
        setSubmitting(false);
        return;
      }

      const model = {
        providerID: parsedModel.providerID,
        modelID: parsedModel.modelID,
        variant: parsedModel.variant,
      };

      const request: CreateLoopFormSubmitRequest = {
        name: currentName.trim(),
        workspaceId: selectedWorkspaceId,
        prompt: currentPrompt.trim(),
        planMode,
        autoAcceptPlan: planMode ? (fullyAutonomous ? true : autoAcceptPlan) : false,
        fullyAutonomous: planMode ? fullyAutonomous : false,
        model,
        cheapModel: cheapModelValueToSelection(selectedCheapModel),
        useWorktree,
      };

      if (attachments.length > 0 && !asDraft) {
        request.attachments = toMessageImageAttachments(attachments);
      }

      if (maxIterations.trim()) {
        const num = parseInt(maxIterations, 10);
        if (!isNaN(num) && num > 0) {
          request.maxIterations = num;
        }
      }

      if (maxConsecutiveErrors.trim()) {
        const num = parseInt(maxConsecutiveErrors, 10);
        if (!isNaN(num) && num >= 0) {
          request.maxConsecutiveErrors = num === 0 ? 0 : num;
        }
      }

      if (activityTimeoutSeconds.trim()) {
        const num = parseInt(activityTimeoutSeconds, 10);
        if (!isNaN(num) && num >= 60) {
          request.activityTimeoutSeconds = num;
        }
      }

      if (selectedBranch && selectedBranch !== currentBranch) {
        request.baseBranch = selectedBranch;
      }

      request.clearPlanningFolder = clearPlanningFolder;
      request.planMode = planMode;

      if (asDraft) {
        request.draft = true;
      }

      try {
        const success = await onSubmit(request);
        if (success && closeOnSuccess) {
          onCancel();
        }
      } catch (error) {
        log.error("Failed to create loop:", error);
      } finally {
        setSubmitting(false);
      }
      // Note: onSubmit and onCancel intentionally NOT in deps (parent callbacks)
      // Note: prompt/name read from refs to avoid stale closures
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [
      selectedWorkspaceId,
      selectedModel,
      selectedCheapModel,
      selectedModelEnabled,
      planMode,
       autoAcceptPlan,
       fullyAutonomous,
       maxIterations,
      maxConsecutiveErrors,
      activityTimeoutSeconds,
      selectedBranch,
      currentBranch,
      clearPlanningFolder,
      useWorktree,
      attachments,
      fullyAutonomous,
    ]
  );

  const handleSubmitClick = useCallback(() => {
    if (formRef.current) {
      formRef.current.requestSubmit();
    }
  }, []);

  const handleSaveAsDraftClick = useCallback(() => {
    if (formRef.current && canSaveDraft) {
      const syntheticEvent = { preventDefault: () => {} } as FormEvent;
      void handleSubmit(syntheticEvent, true);
    }
  }, [canSaveDraft, handleSubmit]);

  useEffect(() => {
    cancelActionRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    submitActionRef.current = handleSubmitClick;
  }, [handleSubmitClick]);

  useEffect(() => {
    saveAsDraftActionRef.current = handleSaveAsDraftClick;
  }, [handleSaveAsDraftClick]);

  const handleExternalCancel = useCallback(() => {
    cancelActionRef.current();
  }, []);

  const handleExternalSubmit = useCallback(() => {
    submitActionRef.current();
  }, []);

  const handleExternalSaveAsDraft = useCallback(() => {
    saveAsDraftActionRef.current();
  }, []);

  // Track previous renderActions deps to detect changes
  const renderActionsRef = useRef<{
    isSubmitting?: boolean;
    canSubmit?: boolean;
    canSaveDraft?: boolean;
    isEditing?: boolean;
    isEditingDraft?: boolean;
    planMode?: boolean;
  }>({});

  useEffect(() => {
    const prev = renderActionsRef.current;
    log.debug("useEffect 5 - renderActions deps changed:", {
      isSubmitting: isSubmitting !== prev.isSubmitting,
      canSubmit: canSubmit !== prev.canSubmit,
      canSaveDraft: canSaveDraft !== prev.canSaveDraft,
      isEditing: isEditing !== prev.isEditing,
      isEditingDraft: isEditingDraft !== prev.isEditingDraft,
      planMode: planMode !== prev.planMode,
    });

    renderActionsRef.current = {
      isSubmitting,
      canSubmit,
      canSaveDraft,
      isEditing,
      isEditingDraft,
      planMode,
    };

    if (renderActions) {
      renderActions({
        isSubmitting,
        canSubmit,
        canSaveDraft,
        isEditing,
        isEditingDraft: isEditingDraft ?? false,
        planMode,
        onCancel: handleExternalCancel,
        onSubmit: handleExternalSubmit,
        onSaveAsDraft: handleExternalSaveAsDraft,
      });
    }
    // Note: renderActions intentionally NOT in deps — notify only on action state changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSubmitting, canSubmit, canSaveDraft, isEditing, isEditingDraft, planMode]);

  return {
    formRef,
    isSubmitting,
    canSubmit,
    canSaveDraft,
    canGenerateTitle,
    handleSubmit,
    handleExternalCancel,
    handleExternalSubmit,
    handleExternalSaveAsDraft,
  };
}
