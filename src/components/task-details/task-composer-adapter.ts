import { useCallback } from "react";
import type {
  MessageAttachment,
  ModelConfig,
  Task,
} from "@/shared";
import type {
  ConversationComposerProps,
  ConversationComposerSubmission,
  ConversationComposerVoice,
} from "../conversation-composer";

interface TaskComposerAdapterOptions {
  task: Task | null;
  isPlanning: boolean;
  isGenerating: boolean;
  canTerminalFollowUp: boolean;
  isLoading: boolean;
  voice: ConversationComposerVoice;
  setPending: (options: {
    message?: string;
    model?: ModelConfig;
    attachments?: MessageAttachment[];
  }) => Promise<{ success: boolean }>;
  sendPlanFeedback: (
    feedback: string,
    attachments?: MessageAttachment[],
  ) => Promise<boolean>;
  sendFollowUp: (
    message: string,
    model?: ModelConfig,
    attachments?: MessageAttachment[],
  ) => Promise<boolean>;
  stopTask: () => Promise<boolean>;
}

export function useTaskComposerAdapter({
  task,
  isPlanning,
  isGenerating,
  canTerminalFollowUp,
  isLoading,
  voice,
  setPending,
  sendPlanFeedback,
  sendFollowUp,
  stopTask,
}: TaskComposerAdapterOptions): ConversationComposerProps | null {
  const submit = useCallback(async ({
    message,
    model,
    attachments,
  }: ConversationComposerSubmission): Promise<boolean> => {
    if (!task) {
      return false;
    }
    if (isPlanning) {
      return sendPlanFeedback(message ?? "", attachments);
    }

    if (canTerminalFollowUp) {
      return sendFollowUp(message ?? "", model ?? undefined, attachments);
    }

    const result = await setPending({
      message: message ?? undefined,
      model: model ?? undefined,
      attachments,
    });
    return result.success;
  }, [
    canTerminalFollowUp,
    isPlanning,
    sendFollowUp,
    sendPlanFeedback,
    setPending,
    task,
  ]);

  if (!task) {
    return null;
  }

  return {
    draftId: `task:${task.config.id}`,
    currentModel: task.config.model,
    modelWorkspaceId: task.config.workspaceId,
    modelEnabled: !isPlanning,
    active: isGenerating,
    disabled: isLoading,
    requireMessage: canTerminalFollowUp,
    voice,
    onSubmit: submit,
    onInterrupt: stopTask,
  };
}
