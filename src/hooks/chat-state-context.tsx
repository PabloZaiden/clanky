/**
 * One app-scoped owner for chat metadata; transcript windows remain view-local.
 */

import { createContext, useCallback, useContext, useEffect, type ReactNode, type SetStateAction } from "react";
import type { Chat } from "@/shared";
import { useOwnedChatActivityState } from "./useChatActivityState";
import type { TranscriptResourceState } from "./useTranscriptResource";

const ChatStateContext = createContext<ReturnType<typeof useOwnedChatActivityState> | null>(null);

export function ChatStateProvider({ children }: { children: ReactNode }) {
  const state = useOwnedChatActivityState();
  return <ChatStateContext value={state}>{children}</ChatStateContext>;
}

export function useChatActivityState() {
  const state = useContext(ChatStateContext);
  if (!state) throw new Error("Chat state requires ChatStateProvider");
  return state;
}

export function useChatResourceState(chatId: string): TranscriptResourceState<Chat> {
  const { chats, getChat, setChats, retainChat } = useChatActivityState();
  const getResource = useCallback(() => getChat(chatId) ?? null, [chatId, getChat]);
  const setResource = useCallback((update: SetStateAction<Chat | null>): void => {
    setChats((current) => {
      const previous = current.find((chat) => chat.config.id === chatId) ?? null;
      const next = typeof update === "function" ? update(previous) : update;
      if (next === previous) return current;
      if (!next) return current.filter((chat) => chat.config.id !== chatId);
      if (!previous) return [...current, next];
      return current.map((chat) => chat.config.id === chatId ? next : chat);
    });
  }, [chatId, setChats]);

  useEffect(() => retainChat(chatId), [chatId, retainChat]);

  return {
    resource: chats.find((chat) => chat.config.id === chatId) ?? null,
    getResource,
    setResource,
  };
}
