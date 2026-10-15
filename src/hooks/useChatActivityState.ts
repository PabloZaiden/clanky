import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { Chat } from "@/shared";
import {
  hasSameChatPresentation,
  reuseChatSnapshotPresentation,
} from "../utils/chat-snapshot";

const CHAT_ACTIVITY_PUBLISH_INTERVAL_MS = 60_000;

export function useChatActivityState() {
  const [chats, publishChats] = useState<Chat[]>([]);
  const latestRef = useRef(new Map<string, Chat>());
  const displayedRef = useRef<Chat[]>([]);
  const pendingRef = useRef(new Set<string>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mountedRef = useRef(true);

  const publish = useCallback((next: Chat[]): void => {
    const previous = displayedRef.current;
    if (previous.length === next.length && next.every((chat, index) => chat === previous[index])) {
      return;
    }
    displayedRef.current = next;
    publishChats(next);
  }, []);

  const scheduleActivity = useCallback((): void => {
    if (pendingRef.current.size === 0) {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      timerRef.current = undefined;
      return;
    }
    if (timerRef.current !== undefined) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      const next = displayedRef.current.map((chat) =>
        pendingRef.current.has(chat.config.id)
          ? latestRef.current.get(chat.config.id) ?? chat
          : chat);
      pendingRef.current.clear();
      publish(next);
    }, CHAT_ACTIVITY_PUBLISH_INTERVAL_MS);
  }, [publish]);

  const setChats = useCallback((
    update: SetStateAction<Chat[]>,
    options: { immediateActivityId?: string } = {},
  ): void => {
    if (!mountedRef.current) return;
    const current = [...latestRef.current.values()];
    const incoming = typeof update === "function" ? update(current) : update;
    const displayed = new Map(displayedRef.current.map((chat) => [chat.config.id, chat]));
    const latest = new Map<string, Chat>();
    const next = incoming.map((chat) => {
      const previous = latestRef.current.get(chat.config.id);
      const normalized = previous ? reuseChatSnapshotPresentation(previous, chat) : chat;
      latest.set(chat.config.id, normalized);
      const visible = displayed.get(chat.config.id);
      if (
        visible
        && options.immediateActivityId !== chat.config.id
        && hasSameChatPresentation(visible, normalized)
      ) {
        if (
          visible.state.lastActivityAt !== normalized.state.lastActivityAt
          || visible.state.revision !== normalized.state.revision
        ) {
          pendingRef.current.add(chat.config.id);
        } else {
          pendingRef.current.delete(chat.config.id);
        }
        return visible;
      }
      pendingRef.current.delete(chat.config.id);
      return normalized;
    });
    latestRef.current = latest;
    for (const id of pendingRef.current) {
      if (!latest.has(id)) pendingRef.current.delete(id);
    }
    publish(next);
    scheduleActivity();
  }, [publish, scheduleActivity]);

  const recordActivity = useCallback((
    id: string,
    timestamp: string,
    source: "stream" | "user" = "stream",
  ): void => {
    if (!mountedRef.current) return;
    const current = latestRef.current.get(id);
    if (!current) return;
    const activityAdvanced = current.state.lastActivityAt === undefined
      || timestamp.localeCompare(current.state.lastActivityAt) > 0;
    const userMessageAdvanced = source === "user"
      && (current.state.lastUserMessageAt === undefined
        || timestamp.localeCompare(current.state.lastUserMessageAt) > 0);
    if (!activityAdvanced && !userMessageAdvanced) return;
    const next: Chat = {
      ...current,
      state: {
        ...current.state,
        lastActivityAt: activityAdvanced ? timestamp : current.state.lastActivityAt,
        ...(userMessageAdvanced ? { lastUserMessageAt: timestamp } : {}),
      },
    };
    latestRef.current.set(id, next);
    if (source === "user") {
      pendingRef.current.delete(id);
      publish(displayedRef.current.map((chat) => chat.config.id === id ? next : chat));
    } else {
      pendingRef.current.add(id);
    }
    scheduleActivity();
  }, [publish, scheduleActivity]);

  const getChat = useCallback((id: string): Chat | undefined => latestRef.current.get(id), []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      timerRef.current = undefined;
      pendingRef.current.clear();
    };
  }, []);

  return { chats, setChats, getChat, recordActivity };
}
