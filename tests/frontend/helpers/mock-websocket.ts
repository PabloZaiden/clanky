/**
 * Mock WebSocket for frontend tests.
 *
 * Replaces the global WebSocket class with a mock that:
 * - Tracks all created connections
 * - Supports sending events to connected clients
 * - Simulates open/close/error events
 * - Parses query parameters (e.g., ?taskId=xxx)
 */

import { beforeEach, afterEach } from "bun:test";

interface MockWebSocketConnection {
  /** The URL the WebSocket was opened with */
  url: string;
  /** Parsed query parameters from the URL */
  queryParams: Record<string, string>;
  /** Whether the connection is open */
  isOpen: boolean;
  /** Messages received by the server (sent from client) */
  sentMessages: string[];
  /** The mock WebSocket instance */
  instance: MockWebSocketInstance;
}

interface MockWebSocketInstance {
  url: string;
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  addEventListener: (type: string, listener: EventListener) => void;
  removeEventListener: (type: string, listener: EventListener) => void;
}

interface MockWebSocketManager {
  /** Get all active connections */
  connections: () => MockWebSocketConnection[];
  /** Get connections matching a URL pattern */
  getConnections: (urlPattern?: string) => MockWebSocketConnection[];
  /** Get the global (non-task-specific) connection */
  getGlobalConnection: () => MockWebSocketConnection | undefined;
  /** Get a task-specific connection */
  getTaskConnection: (taskId: string) => MockWebSocketConnection | undefined;
  /** Send an event to all connected clients */
  sendEvent: (event: unknown) => void;
  /** Send an event to a specific connection */
  sendEventTo: (connection: MockWebSocketConnection, event: unknown) => void;
  /** Simulate connection open for all pending connections */
  openAll: () => void;
  /** Simulate connection close for all connections */
  closeAll: (code?: number, reason?: string) => void;
  /** Simulate an error on all connections */
  errorAll: () => void;
  /** Reset all state */
  reset: () => void;
  /** Install the mock (replace global WebSocket) */
  install: () => void;
  /** Uninstall the mock (restore global WebSocket) */
  uninstall: () => void;
}

// WebSocket readyState constants
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/**
 * Parse query parameters from a URL.
 */
function parseQueryParams(url: string): Record<string, string> {
  const params: Record<string, string> = {};
  try {
    const parsed = new URL(url, "http://localhost");
    parsed.searchParams.forEach((value, key) => {
      params[key] = value;
    });
  } catch {
    // Try extracting query string directly
    const qIdx = url.indexOf("?");
    if (qIdx >= 0) {
      const qs = url.substring(qIdx + 1);
      for (const pair of qs.split("&")) {
        const [key, value] = pair.split("=");
        if (key) {
          params[key] = decodeURIComponent(value ?? "");
        }
      }
    }
  }
  return params;
}

/**
 * Create a mock WebSocket manager.
 */
export function createMockWebSocket(): MockWebSocketManager {
  const activeConnections: MockWebSocketConnection[] = [];
  let OriginalWebSocket: typeof WebSocket | null = null;
  let OriginalWindowWebSocket: typeof WebSocket | null = null;
  let autoOpen = true;

  function createMockInstance(url: string): MockWebSocketInstance {
    const listeners: Record<string, EventListener[]> = {};

    const instance: MockWebSocketInstance = {
      url,
      readyState: CONNECTING,
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      send: (data: string) => {
        const conn = activeConnections.find((c) => c.instance === instance);
        if (conn) {
          conn.sentMessages.push(data);
        }
      },
      close: (code = 1000, reason = "") => {
        instance.readyState = CLOSING;
        const conn = activeConnections.find((c) => c.instance === instance);
        if (conn) {
          conn.isOpen = false;
        }
        instance.readyState = CLOSED;
        const closeEvent = new CloseEvent("close", { code, reason, wasClean: true });
        instance.onclose?.(closeEvent);
        listeners["close"]?.forEach((l) => l(closeEvent));
      },
      addEventListener: (type: string, listener: EventListener) => {
        if (!listeners[type]) {
          listeners[type] = [];
        }
        listeners[type]!.push(listener);
      },
      removeEventListener: (type: string, listener: EventListener) => {
        if (listeners[type]) {
          listeners[type] = listeners[type]!.filter((l) => l !== listener);
        }
      },
    };

    const connection: MockWebSocketConnection = {
      url,
      queryParams: parseQueryParams(url),
      isOpen: false,
      sentMessages: [],
      instance,
    };
    activeConnections.push(connection);

    // Auto-open in a microtask (mimicking real WebSocket behavior)
    if (autoOpen) {
      queueMicrotask(() => {
        if (instance.readyState === CONNECTING) {
          instance.readyState = OPEN;
          connection.isOpen = true;
          const openEvent = new Event("open");
          instance.onopen?.(openEvent);
          listeners["open"]?.forEach((l) => l(openEvent));
        }
      });
    }

    return instance;
  }

  const manager: MockWebSocketManager = {
    connections: () => [...activeConnections],

    getConnections: (urlPattern) => {
      if (!urlPattern) return [...activeConnections];
      return activeConnections.filter((c) => c.url.includes(urlPattern));
    },

    getGlobalConnection: () => {
      return activeConnections.find((c) => !c.queryParams["taskId"]);
    },

    getTaskConnection: (taskId) => {
      return activeConnections.find((c) => c.queryParams["taskId"] === taskId);
    },

    sendEvent: (event) => {
      const data = JSON.stringify(event);
      for (const conn of activeConnections) {
        if (conn.isOpen) {
          const msgEvent = new MessageEvent("message", { data });
          conn.instance.onmessage?.(msgEvent);
        }
      }
    },

    sendEventTo: (connection, event) => {
      if (connection.isOpen) {
        const data = JSON.stringify(event);
        const msgEvent = new MessageEvent("message", { data });
        connection.instance.onmessage?.(msgEvent);
      }
    },

    openAll: () => {
      for (const conn of activeConnections) {
        if (!conn.isOpen && conn.instance.readyState === CONNECTING) {
          conn.instance.readyState = OPEN;
          conn.isOpen = true;
          const openEvent = new Event("open");
          conn.instance.onopen?.(openEvent);
        }
      }
    },

    closeAll: (code = 1000, reason = "") => {
      for (const conn of activeConnections) {
        if (conn.isOpen) {
          conn.instance.close(code, reason);
        }
      }
    },

    errorAll: () => {
      for (const conn of activeConnections) {
        if (conn.isOpen) {
          const errorEvent = new Event("error");
          conn.instance.onerror?.(errorEvent);
        }
      }
    },

    reset: () => {
      // Close all active connections
      for (const conn of [...activeConnections]) {
        if (conn.isOpen) {
          conn.instance.readyState = CLOSED;
          conn.isOpen = false;
        }
      }
      activeConnections.length = 0;
      autoOpen = true;
    },

    install: () => {
      if (!OriginalWebSocket) {
        OriginalWebSocket = globalThis.WebSocket;
      }
      if (!OriginalWindowWebSocket) {
        OriginalWindowWebSocket = window.WebSocket;
      }
      // Replace global WebSocket with our mock constructor
      const MockWebSocketConstructor = function MockWebSocket(url: string | URL) {
        return createMockInstance(url.toString());
      } as unknown as typeof WebSocket;
      globalThis.WebSocket = MockWebSocketConstructor;
      window.WebSocket = MockWebSocketConstructor;

      // Copy static constants
      (globalThis.WebSocket as unknown as Record<string, number>)["CONNECTING"] = CONNECTING;
      (globalThis.WebSocket as unknown as Record<string, number>)["OPEN"] = OPEN;
      (globalThis.WebSocket as unknown as Record<string, number>)["CLOSING"] = CLOSING;
      (globalThis.WebSocket as unknown as Record<string, number>)["CLOSED"] = CLOSED;
      (window.WebSocket as unknown as Record<string, number>)["CONNECTING"] = CONNECTING;
      (window.WebSocket as unknown as Record<string, number>)["OPEN"] = OPEN;
      (window.WebSocket as unknown as Record<string, number>)["CLOSING"] = CLOSING;
      (window.WebSocket as unknown as Record<string, number>)["CLOSED"] = CLOSED;
    },

    uninstall: () => {
      manager.reset();
      if (OriginalWebSocket) {
        globalThis.WebSocket = OriginalWebSocket;
        OriginalWebSocket = null;
      }
      if (OriginalWindowWebSocket) {
        window.WebSocket = OriginalWindowWebSocket;
        OriginalWindowWebSocket = null;
      }
    },
  };

  return manager;
}

/**
 * Setup hook that creates a mock WebSocket manager and automatically
 * installs/uninstalls around each test.
 *
 * @example
 * ```typescript
 * const ws = useMockWebSocket();
 * // ws is ready to use inside test functions
 * ```
 */
export function useMockWebSocket(): MockWebSocketManager {
  const ws = createMockWebSocket();

  beforeEach(() => {
    ws.reset();
    ws.install();
  });

  afterEach(() => {
    ws.uninstall();
  });

  return ws;
}
