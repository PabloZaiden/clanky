import { useCallback } from "react";
import { DEFAULT_CHAT_INTERRUPT_REASON } from "@/shared";
import type { Chat } from "@/shared";
import { CHAT_STARTUP_STAGE_LABELS } from "@/shared/chat";
import type {
  ConversationComposerProps,
  ConversationComposerSubmission,
} from "../conversation-composer";
import { apiRequest } from "../../lib/api-client";
import { getClankyClientId } from "../../lib/clanky-client-id";
import {
  getChatErrorMessage,
} from "./chat-lifecycle";
import type { ChatComposerAdapterOptions } from "./types";

export function useChatComposerAdapter({
  chat,
  chatId,
  isEmbedded,
  isActive,
  isExternallyBusy = false,
  onChatSnapshot,
  markChatStarting,
  refreshChat,
  onSendMessage,
  voice,
}: ChatComposerAdapterOptions): ConversationComposerProps | null {
  const submit = useCallback(async ({
    message,
    model,
    attachments,
  }: ConversationComposerSubmission): Promise<void> => {
    if (!chat) {
      throw new Error("Chat not found");
    }
    if (model) {
      const updatedChat = await apiRequest<Chat>(`/api/chats/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
        action: "Update chat model",
        fallbackMessage: "Failed to update chat model",
      });
      onChatSnapshot(updatedChat);
    }

    if (!message && attachments.length === 0) {
      return;
    }

    if (onSendMessage) {
      const nextChat = await onSendMessage({
        message: message ?? undefined,
        attachments,
      });
      onChatSnapshot(nextChat);
      return;
    }

    const data = await apiRequest<{ chat?: Chat }>(`/api/chats/${chatId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        attachments,
        clientId: getClankyClientId(),
      }),
      action: "Send chat message",
      fallbackMessage: "Failed to send chat message",
    });
    if (data.chat) {
      onChatSnapshot(data.chat);
    } else if (isActive) {
      await refreshChat();
    } else {
      markChatStarting();
    }
  }, [
    chat,
    chatId,
    isActive,
    markChatStarting,
    onChatSnapshot,
    onSendMessage,
    refreshChat,
  ]);

  const interrupt = useCallback(async (): Promise<void> => {
    try {
      const nextChat = await apiRequest<Chat>(`/api/chats/${chatId}/interrupt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: DEFAULT_CHAT_INTERRUPT_REASON }),
        action: "Interrupt chat",
        fallbackMessage: "Failed to interrupt chat",
      });
      onChatSnapshot(nextChat);
    } catch (error) {
      throw new Error(getChatErrorMessage(error), { cause: error });
    }
  }, [chatId, onChatSnapshot]);

  if (!chat) {
    return null;
  }

  return {
    draftId: `chat:${chatId}`,
    tokenUsage: chat.state.usage ?? null,
    currentModel: chat.config.model,
    modelWorkspaceId: isEmbedded || chat.config.source?.kind === "execution_host"
      ? undefined
      : chat.config.workspaceId,
    modelEnabled: !isEmbedded,
    active: isActive,
    externallyBusy: isExternallyBusy,
    status: chat.state.startupStage
      ? { label: `${CHAT_STARTUP_STAGE_LABELS[chat.state.startupStage]}...` }
      : undefined,
    voice,
    onSubmit: submit,
    onInterrupt: interrupt,
  };
}
