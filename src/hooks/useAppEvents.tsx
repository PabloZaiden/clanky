import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { LoopEvent, ChatEvent, SshSessionEvent } from "../types";
import {
  useWebSocket,
  type UseWebSocketResult,
  type WebSocketConnectionStatus,
} from "./useWebSocket";

type AppEvent = LoopEvent | ChatEvent | SshSessionEvent;
type AppEventHandler<T extends AppEvent = AppEvent> = (event: T) => void;

interface AppEventsContextValue {
  events: AppEvent[];
  status: WebSocketConnectionStatus;
  subscribe: <T extends AppEvent>(handler: AppEventHandler<T>) => () => void;
  clearEvents: UseWebSocketResult<AppEvent>["clearEvents"];
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

  const { events, status, clearEvents } = useWebSocket<AppEvent>({
    url: "/api/ws",
    onEvent: handleEvent,
  });

  const subscribe = useCallback(<T extends AppEvent>(handler: AppEventHandler<T>) => {
    const appHandler = handler as AppEventHandler;
    handlersRef.current.add(appHandler);
    return () => {
      handlersRef.current.delete(appHandler);
    };
  }, []);

  const value = useMemo<AppEventsContextValue>(() => ({
    events,
    status,
    subscribe,
    clearEvents,
  }), [clearEvents, events, status, subscribe]);

  return (
    <AppEventsContext.Provider value={value}>
      {children}
    </AppEventsContext.Provider>
  );
}

export function useAppEvents<T extends AppEvent>(
  onEvent?: AppEventHandler<T>,
): { events: T[]; status: WebSocketConnectionStatus; clearEvents: UseWebSocketResult<AppEvent>["clearEvents"] } {
  const context = useContext(AppEventsContext);
  if (!context) {
    throw new Error("useAppEvents must be used within AppEventsProvider");
  }

  useEffect(() => {
    if (!onEvent) {
      return undefined;
    }
    return context.subscribe(onEvent);
  }, [context, onEvent]);

  return {
    events: context.events as T[],
    status: context.status,
    clearEvents: context.clearEvents,
  };
}
