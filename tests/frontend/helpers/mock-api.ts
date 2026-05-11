/**
 * Mock API for frontend tests.
 *
 * Provides a fetch interceptor that matches registered route patterns
 * and returns configured responses. Tracks call history for assertions.
 */

import { beforeEach, afterEach } from "bun:test";
import { DEFAULT_API_ROUTES } from "./default-api-routes";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface RouteParams {
  [key: string]: string;
}

interface MockRequest {
  method: HttpMethod;
  url: string;
  params: RouteParams;
  body: unknown;
  headers: Headers;
}

interface CallRecord {
  method: HttpMethod;
  url: string;
  params: RouteParams;
  body: unknown;
  timestamp: number;
}

type RouteHandler = (req: MockRequest) => unknown | Promise<unknown>;

interface RouteConfig {
  pattern: string;
  regex: RegExp;
  paramNames: string[];
  method: HttpMethod;
  handler: RouteHandler;
  statusCode: number;
}

interface MockApiInstance {
  /** Register a GET route handler */
  get: (pattern: string, handler: RouteHandler, statusCode?: number) => void;
  /** Register a POST route handler */
  post: (pattern: string, handler: RouteHandler, statusCode?: number) => void;
  /** Register a PUT route handler */
  put: (pattern: string, handler: RouteHandler, statusCode?: number) => void;
  /** Register a PATCH route handler */
  patch: (pattern: string, handler: RouteHandler, statusCode?: number) => void;
  /** Register a DELETE route handler */
  delete: (pattern: string, handler: RouteHandler, statusCode?: number) => void;
  /** Get call records for a specific pattern and optional method */
  calls: (pattern: string, method?: HttpMethod) => CallRecord[];
  /** Get all call records */
  allCalls: () => CallRecord[];
  /** Reset all routes and call history */
  reset: () => void;
  /** Install the mock (replace global fetch) */
  install: () => void;
  /** Uninstall the mock (restore global fetch) */
  uninstall: () => void;
}

/**
 * Convert a route pattern like "/api/loops/:id" to a regex.
 */
function patternToRegex(pattern: string): { regex: RegExp; paramNames: string[] } {
  const paramNames: string[] = [];
  const regexStr = pattern
    .replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name: string) => {
      paramNames.push(name);
      return "([^/]+)";
    })
    .replace(/\//g, "\\/");
  return {
    regex: new RegExp(`^${regexStr}$`),
    paramNames,
  };
}

/**
 * Extract URL path from a full URL or relative path.
 */
function extractPath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    // Relative URL - extract path before query string
    const queryIndex = url.indexOf("?");
    return queryIndex >= 0 ? url.substring(0, queryIndex) : url;
  }
}

function createRouteConfig(method: HttpMethod, pattern: string, handler: RouteHandler, statusCode = 200): RouteConfig {
  const { regex, paramNames } = patternToRegex(pattern);
  return { pattern, regex, paramNames, method, handler, statusCode };
}

const DEFAULT_ROUTES: RouteConfig[] = DEFAULT_API_ROUTES.map((route) =>
  createRouteConfig(route.method, route.pattern, (req) => route.handler(req.params), route.statusCode),
);

/**
 * Create a mock API instance for intercepting fetch calls.
 *
 * @example
 * ```typescript
 * const api = createMockApi();
 * api.get("/api/loops", () => [createLoop()]);
 * api.post("/api/loops", (req) => createLoop({ config: { prompt: req.body.prompt } }));
 * api.install();
 * // ... run tests ...
 * api.uninstall();
 * ```
 */
export function createMockApi(): MockApiInstance {
  const routes: RouteConfig[] = [];
  const callHistory: CallRecord[] = [];
  let originalFetch: typeof globalThis.fetch | null = null;
  let originalWindowFetch: typeof window.fetch | null = null;

  function addRoute(method: HttpMethod, pattern: string, handler: RouteHandler, statusCode = 200): void {
    routes.push(createRouteConfig(method, pattern, handler, statusCode));
  }

  function matchRoute(routeSet: RouteConfig[], method: HttpMethod, path: string): { route: RouteConfig; params: RouteParams } | null {
    // Iterate in reverse so that later registrations take priority (allows overriding defaults)
    for (let i = routeSet.length - 1; i >= 0; i--) {
      const route = routeSet[i]!;
      if (route.method !== method) continue;
      const match = route.regex.exec(path);
      if (match) {
        const params: RouteParams = {};
        route.paramNames.forEach((name, j) => {
          params[name] = match[j + 1]!;
        });
        return { route, params };
      }
    }
    return null;
  }

  const mockFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = ((init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()) as HttpMethod;
    const path = extractPath(url);

    const result = matchRoute(routes, method, path) ?? matchRoute(DEFAULT_ROUTES, method, path);
    if (!result) {
      // Return 404 for unmatched routes
      return new Response(JSON.stringify({ error: "not_found", message: `No mock handler for ${method} ${path}` }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Parse body
    let body: unknown = undefined;
    if (init?.body) {
      try {
        body = JSON.parse(init.body as string);
      } catch {
        body = init.body;
      }
    } else if (input instanceof Request) {
      try {
        body = await input.clone().json();
      } catch {
        // No JSON body
      }
    }

    const headers = init?.headers
      ? new Headers(init.headers)
      : input instanceof Request
        ? input.headers
        : new Headers();

    const mockReq: MockRequest = {
      method,
      url,
      params: result.params,
      body,
      headers,
    };

    // Record the call
    callHistory.push({
      method,
      url: path,
      params: result.params,
      body,
      timestamp: Date.now(),
    });

    try {
      const responseData = await result.route.handler(mockReq);
      if (responseData instanceof Response) {
        return responseData;
      }
      return new Response(JSON.stringify(responseData), {
        status: result.route.statusCode,
        headers: { "Content-Type": "application/json" },
      });
    } catch (error) {
      if (error instanceof MockApiError) {
        return new Response(JSON.stringify(error.body), {
          status: error.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "internal_error", message: String(error) }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }
  };

  return {
    get: (pattern, handler, statusCode) => addRoute("GET", pattern, handler, statusCode),
    post: (pattern, handler, statusCode) => addRoute("POST", pattern, handler, statusCode ?? 201),
    put: (pattern, handler, statusCode) => addRoute("PUT", pattern, handler, statusCode),
    patch: (pattern, handler, statusCode) => addRoute("PATCH", pattern, handler, statusCode),
    delete: (pattern, handler, statusCode) => addRoute("DELETE", pattern, handler, statusCode),

    calls: (pattern, method) => {
      return callHistory.filter((call) => {
        const { regex } = patternToRegex(pattern);
        const pathMatch = regex.test(call.url);
        return pathMatch && (!method || call.method === method);
      });
    },

    allCalls: () => [...callHistory],

    reset: () => {
      routes.length = 0;
      callHistory.length = 0;
    },

    install: () => {
      if (!originalFetch) {
        originalFetch = globalThis.fetch;
      }
      if (typeof window !== "undefined" && !originalWindowFetch) {
        originalWindowFetch = window.fetch;
      }
      globalThis.fetch = mockFetch as typeof globalThis.fetch;
      if (typeof window !== "undefined") {
        window.fetch = mockFetch as typeof window.fetch;
      }
    },

    uninstall: () => {
      if (originalFetch && globalThis.fetch === mockFetch) {
        globalThis.fetch = originalFetch;
        originalFetch = null;
      }
      if (typeof window !== "undefined" && originalWindowFetch && window.fetch === mockFetch) {
        window.fetch = originalWindowFetch;
        originalWindowFetch = null;
      }
    },
  };
}

/**
 * Error class to throw from route handlers to return a specific HTTP error response.
 *
 * @example
 * ```typescript
 * api.post("/api/loops", () => {
 *   throw new MockApiError(409, { error: "uncommitted_changes", message: "Dirty repo" });
 * });
 * ```
 */
export class MockApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`MockApiError(${status})`);
  }
}

/**
 * Setup hook that creates a mock API instance and automatically
 * installs/uninstalls around each test.
 *
 * @example
 * ```typescript
 * const api = useMockApi();
 * // api is ready to use inside test functions
 * ```
 */
export function useMockApi(): MockApiInstance {
  const api = createMockApi();

  beforeEach(() => {
    api.reset();
    api.install();
  });

  afterEach(() => {
    api.uninstall();
  });

  return api;
}
