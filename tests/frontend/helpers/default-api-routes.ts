type HttpMethod = "GET";

type RouteParams = Record<string, string>;

interface DefaultApiRouteDefinition {
  method: HttpMethod;
  pattern: string;
  statusCode: number;
  handler: (params: RouteParams) => unknown;
}

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

function defaultRoute(pattern: string, handler: (params: RouteParams) => unknown, statusCode = 200): DefaultApiRouteDefinition {
  return {
    method: "GET",
    pattern,
    statusCode,
    handler,
  };
}

export const DEFAULT_API_ROUTES: DefaultApiRouteDefinition[] = [
  defaultRoute("/api/models", () => []),
  defaultRoute("/api/git/branches", () => ({
    branches: [],
    currentBranch: "",
  })),
  defaultRoute("/api/git/default-branch", () => ({
    defaultBranch: "",
  })),
  defaultRoute("/api/check-planning-dir", () => ({
    warning: null,
  })),
  defaultRoute("/api/loops/:id/plan", () => ({
    exists: false,
    content: "",
  })),
  defaultRoute("/api/loops/:id/status-file", () => ({
    exists: false,
    content: "",
  })),
  defaultRoute("/api/loops/:id/port-forwards", () => []),
  defaultRoute("/api/loops/:id/pull-request", () => ({
    enabled: false,
    destinationType: "disabled",
    disabledReason: "disabled",
  })),
  defaultRoute("/api/workspaces/:id/agents-md", () => ({
    content: "# AGENTS.md",
    fileExists: true,
    analysis: {
      isOptimized: false,
      currentVersion: null,
      updateAvailable: false,
    },
  })),
  defaultRoute("/api/preferences/last-model", () => null),
  defaultRoute("/api/preferences/last-cheap-model", () => null),
  defaultRoute("/api/preferences/last-directory", () => null),
  defaultRoute("/api/preferences/log-level", () => ({
    level: "info",
  })),
  defaultRoute("/api/preferences/markdown-rendering", () => ({
    enabled: true,
  })),
  defaultRoute("/api/preferences/file-explorer-full-tree", () => ({
    enabled: true,
  })),
  defaultRoute("/api/preferences/dashboard-view-mode", () => ({
    mode: "rows",
  })),
  defaultRoute("/api/auth/issuer", () => ({
    canonicalIssuer: null,
    effectiveIssuer: "urn:ralpher:instance:test",
  })),
  defaultRoute("/api/auth/sessions", () => []),
  defaultRoute("/api/auth/cli-cookies", () => ({
    cookies: "",
  })),
];

export function resolveDefaultApiRoute(
  method: string,
  path: string,
): { statusCode: number; body: unknown } | null {
  for (const route of DEFAULT_API_ROUTES) {
    if (route.method !== method) {
      continue;
    }

    const { regex, paramNames } = patternToRegex(route.pattern);
    const match = regex.exec(path);
    if (!match) {
      continue;
    }

    const params: RouteParams = {};
    paramNames.forEach((name, index) => {
      params[name] = match[index + 1]!;
    });

    return {
      statusCode: route.statusCode,
      body: route.handler(params),
    };
  }

  return null;
}
