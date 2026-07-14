import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AgentEvent, TaskEvent, ChatEvent, PreviewEvent, SshSessionEvent } from "@/shared";
import {
  useWebSocket,
  type UseWebSocketResult,
  type WebSocketConnectionStatus,
} from "./useWebSocket";

type AppEvent = TaskEvent | ChatEvent | SshSessionEvent | AgentEvent | PreviewEvent;
type AppEventHandler = (event: AppEvent) => void;
type AppEventFilter<T extends AppEvent> = (event: AppEvent) => event is T;

interface AppEventsContextValue {
  status: WebSocketConnectionStatus;
  subscribe: (handler: AppEventHandler) => () => void;
}

const AppEventsContext = createContext<AppEventsContextValue | null>(null);

export function AppEventsProvider({ children }: { children: ReactNode }) {
  const parentContext = useContext(AppEventsContext);
  if (parentContext) {
    return <>{children}</>;
  }

  return <AppEventsProviderRoot>{children}</AppEventsProviderRoot>;
}

function AppEventsProviderRoot({ children }: { children: ReactNode }) {
  const handlersRef = useRef(new Set<AppEventHandler>());

  const handleEvent = useCallback((event: AppEvent) => {
    for (const handler of handlersRef.current) {
      handler(event);
    }
  }, []);

  const { status } = useWebSocket<AppEvent>({
    url: "/api/ws",
    onEvent: handleEvent,
  });

  const subscribe = useCallback((handler: AppEventHandler) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  const value = useMemo<AppEventsContextValue>(() => ({
    status,
    subscribe,
  }), [status, subscribe]);

  return (
    <AppEventsContext.Provider value={value}>
      {children}
    </AppEventsContext.Provider>
  );
}

export function useAppEvents<T extends AppEvent>(
  onEvent?: (event: T) => void,
  filter?: AppEventFilter<T>,
): { events: T[]; status: WebSocketConnectionStatus; clearEvents: UseWebSocketResult<AppEvent>["clearEvents"] } {
  const context = useContext(AppEventsContext);
  const [events, setEvents] = useState<T[]>([]);
  const clearEvents = useCallback(() => setEvents([]), []);
  if (!context) {
    throw new Error("useAppEvents must be used within AppEventsProvider");
  }
  const { subscribe, status } = context;

  useEffect(() => {
    return subscribe((event: AppEvent) => {
      if (filter && !filter(event)) {
        return;
      }
      const typedEvent = event as T;
      setEvents((prev) => [...prev, typedEvent].slice(-1000));
      onEvent?.(typedEvent);
    });
  }, [filter, onEvent, subscribe]);

  return {
    events,
    status,
    clearEvents,
  };
}

export function isTaskEvent(event: AppEvent): event is TaskEvent {
  return event.type.startsWith("task.");
}

export function isChatEvent(event: AppEvent): event is ChatEvent {
  return event.type.startsWith("chat.");
}

export function isSshSessionEvent(event: AppEvent): event is SshSessionEvent {
  return event.type.startsWith("ssh_session.");
}

export function isAgentEvent(event: AppEvent): event is AgentEvent {
  return event.type.startsWith("agent.");
}

export function isPreviewEvent(event: AppEvent): event is PreviewEvent {
  return event.type.startsWith("preview.");
}
