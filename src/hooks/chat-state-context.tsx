/**
 * One app-scoped owner for chat metadata; transcript windows remain view-local.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode, type SetStateAction } from "react";
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
  const { chats, getChat, retainChat } = useChatActivityState();
  const leaseRef = useMemo<{ current: ReturnType<typeof retainChat> | null }>(
    () => ({ current: null }),
    [chatId, retainChat],
  );
  const getResource = useCallback(() => getChat(chatId) ?? null, [chatId, getChat]);
  const setResource = useCallback((update: SetStateAction<Chat | null>): void => {
    leaseRef.current?.setChat(update);
  }, [leaseRef]);

  useEffect(() => {
    const lease = retainChat(chatId);
    leaseRef.current = lease;
    return () => {
      leaseRef.current = null;
      lease.release();
    };
  }, [chatId, leaseRef, retainChat]);

  return {
    resource: chats.find((chat) => chat.config.id === chatId) ?? null,
    getResource,
    setResource,
  };
}
