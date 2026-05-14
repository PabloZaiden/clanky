/**
 * Frontend test setup for happy-dom environment.
 *
 * This file registers the happy-dom global DOM environment and sets up
 * necessary mocks for browser APIs used by the React components.
 */

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, mock } from "bun:test";
import * as matchers from "@testing-library/jest-dom/matchers";
import { resolveDefaultApiRoute } from "./helpers/default-api-routes";
import { MockFitAddon, MockTerminal, resetGhosttyWebMockState } from "./helpers/mock-ghostty-web";

// Extend Bun's expect with jest-dom matchers (toBeInTheDocument, toHaveTextContent, etc.)
expect.extend(matchers);

mock.module("ghostty-web", () => ({
  init: async () => {},
  Terminal: MockTerminal,
  FitAddon: MockFitAddon,
}));

// Register happy-dom globals (window, document, navigator, etc.)
GlobalRegistrator.register();

// Mock ResizeObserver (not implemented in happy-dom)
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;

// Mock window.matchMedia (not implemented in happy-dom)
window.matchMedia = (query: string) =>
  ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

// Mock window.scrollTo (not implemented in happy-dom)
window.scrollTo = () => {};

// Mock IntersectionObserver (not implemented in happy-dom)
class MockIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.IntersectionObserver = MockIntersectionObserver as unknown as typeof IntersectionObserver;

class DefaultMockWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readyState = DefaultMockWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(url: string | URL) {
    super();
    this.url = url.toString();
    queueMicrotask(() => {
      if (this.readyState !== DefaultMockWebSocket.CONNECTING) {
        return;
      }
      this.readyState = DefaultMockWebSocket.OPEN;
      const event = new Event("open");
      this.onopen?.(event);
      this.dispatchEvent(event);
    });
  }

  send() {}

  close(code = 1000, reason = "") {
    if (this.readyState === DefaultMockWebSocket.CLOSED) {
      return;
    }
    this.readyState = DefaultMockWebSocket.CLOSED;
    const event = new CloseEvent("close", { code, reason, wasClean: true });
    this.onclose?.(event);
    this.dispatchEvent(event);
  }
}
globalThis.WebSocket = DefaultMockWebSocket as unknown as typeof WebSocket;
window.WebSocket = DefaultMockWebSocket as unknown as typeof WebSocket;

// Set a proper base URL so relative fetch URLs (e.g. "/api/loops") work correctly.
// Without this, document.location is "about:blank" and new Request("/api/...") throws.
if (window.location.href === "about:blank") {
  window.location.href = "http://localhost:3000/";
}

const originalFetch = globalThis.fetch;

function resolveRequestUrl(input: string | URL | Request): URL | null {
  try {
    if (typeof input === "string") {
      return new URL(input, window.location.href);
    }
    if (input instanceof URL) {
      return input;
    }
    return new URL(input.url, window.location.href);
  } catch {
    return null;
  }
}

const frontendFetchGuard = Object.assign(
  async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const resolvedUrl = resolveRequestUrl(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");

    if (
      resolvedUrl &&
      resolvedUrl.origin === window.location.origin &&
      resolvedUrl.pathname.startsWith("/api/")
    ) {
      const defaultRoute = resolveDefaultApiRoute(method.toUpperCase(), resolvedUrl.pathname);
      if (defaultRoute) {
        return new Response(JSON.stringify(defaultRoute.body), {
          status: defaultRoute.statusCode,
          headers: { "Content-Type": "application/json" },
        });
      }

      throw new Error(
        `Unexpected frontend test network request: ${method.toUpperCase()} ${resolvedUrl.pathname}. ` +
          "Mock this API call in the test instead of relying on a live app server.",
      );
    }

    return await originalFetch(input, init);
  },
  {
    preconnect: originalFetch.preconnect,
  },
) as typeof globalThis.fetch;

// Clean up after each test to prevent DOM leaks between tests
afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  globalThis.fetch = frontendFetchGuard;
  window.fetch = frontendFetchGuard;
  resetGhosttyWebMockState();
});

// Reset location before each test so pathname-based public base path inference
// never leaks between unrelated test files.
beforeEach(() => {
  window.location.href = "http://localhost:3000/";
  window.location.hash = "#/";
  window.localStorage.clear();
  window.sessionStorage.clear();
  globalThis.fetch = frontendFetchGuard;
  window.fetch = frontendFetchGuard;
  resetGhosttyWebMockState();
});
