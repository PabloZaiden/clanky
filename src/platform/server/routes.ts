import { compileRouteTable as compileCoreRouteTable, matchCompiledRouteTable as matchCoreRouteTable } from "@pablozaiden/webapp/server";
import { invalidRouteDefinition, type HttpMethod, type CompiledRoutePatterns } from "@pablozaiden/webapp/routing";
export { buildCompiledRoutePath, compareRoutePatterns, compileRoutePatterns, matchCompiledRoutePattern, HTTP_METHODS } from "@pablozaiden/webapp/routing";
export type { CompiledRouteCapture, CompiledRoutePattern, CompiledRoutePatternMatch, CompiledRoutePatterns, CompiledRouteSegment, HttpMethod, RouteCaptureValue } from "@pablozaiden/webapp/routing";
import type { Server } from "bun";
import type { CurrentUser, PartialResultMetadata } from "../contracts";
import type { AuthenticatedRequestState } from "./auth/types";
import type { RealtimeBus, ResourceRealtimeEvent, RealtimeTarget } from "@pablozaiden/webapp/server";
import type { DelegatedInvocation, MatchedRouteOperation, RouteDelegationMetadata } from "./delegation";

export type RouteAuth = "required" | "user" | "admin" | "owner" | "public" | "optional";
export type SameOriginMode = "mutations" | "always" | "never";
export type UserOwnedResource = { userId: string };
export type UserIdSelector<TResource> = (resource: TResource) => string | undefined;

export interface UserScopedRealtimePublisher<TEvent = unknown> {
  readonly _eventType?: TEvent;
  publishChanged<TPayload = unknown>(resource: string, options?: Omit<ResourceRealtimeEvent<TPayload>, "type" | "resource" | "action"> & { target?: RealtimeTarget }): void;
  publishEntityChanged<TPayload = unknown>(resource: string, id: string, options?: Omit<ResourceRealtimeEvent<TPayload>, "type" | "resource" | "action" | "id"> & { target?: RealtimeTarget }): void;
  publishDeleted<TPayload = unknown>(resource: string, id: string, options?: Omit<ResourceRealtimeEvent<TPayload>, "type" | "resource" | "action" | "id"> & { target?: RealtimeTarget }): void;
  publishSettingsChanged<TPayload = unknown>(options?: Omit<ResourceRealtimeEvent<TPayload>, "type" | "resource" | "action"> & { target?: RealtimeTarget }): void;
}

export interface RouteContext<TParams extends Record<string, string> = Record<string, string>, TEvent = unknown> {
  params: TParams;
  auth: AuthenticatedRequestState;
  user?: CurrentUser;
  delegation?: DelegatedInvocation;
  requireUser(): CurrentUser;
  requireAdmin(): CurrentUser;
  requireOwner(): CurrentUser;
  assertUser(userId: string): CurrentUser;
  filterOwned<TResource extends UserOwnedResource>(resources: readonly TResource[]): TResource[];
  filterOwned<TResource>(resources: readonly TResource[], getUserId: UserIdSelector<TResource>): TResource[];
  requireOwned<TResource extends UserOwnedResource>(resource: TResource | null | undefined): TResource;
  requireOwned<TResource>(resource: TResource | null | undefined, getUserId: UserIdSelector<TResource>): TResource;
  realtime: RealtimeBus<TEvent>;
  userRealtime: UserScopedRealtimePublisher<TEvent>;
  server?: Server<unknown>;
}

export type WebAppRouteHandler<TParams extends Record<string, string> = Record<string, string>, TEvent = unknown> = (
  req: Request,
  ctx: RouteContext<TParams, TEvent>,
) => Response | undefined | Promise<Response | undefined>;

/** Runs after route authentication and policy checks, including delegated grants. */
export type WebAppRouteMiddleware<TEvent = unknown> = (
  req: Request,
  ctx: RouteContext<Record<string, string>, TEvent>,
  operation: MatchedRouteOperation,
  invoke: () => Promise<Response | undefined>,
) => Response | undefined | Promise<Response | undefined>;

export interface RouteAutomationCredentialResource {
  name: string;
  idParameter?: string;
  purpose: string;
}

export type RouteAutomationCredential = {
  kind: "ssh";
  input?: string;
  header?: string;
  mapInput?: string;
  unavailableInput?: string;
} & (
  | {
      serverParameter: string;
      hostInput?: never;
      resource?: never;
    }
  | {
      serverParameter?: never;
      hostInput: string;
      resource?: never;
    }
  | {
      serverParameter?: never;
      hostInput?: never;
      resource: RouteAutomationCredentialResource;
    }
);

export interface RouteAutomationMetadata {
  policy: "read" | "write" | "confirm" | "excluded";
  /** Optional policy for an application-admitted execution, never a credential grant. */
  execution?: {
    policy: "read" | "write" | "confirm";
    requestFormat?: "raw";
    responseFormat?: "file";
    privateResponse?: boolean;
    requestHeaders?: readonly string[];
  };
  reason?: string;
  hiddenInputs?: readonly string[];
  hiddenQuery?: readonly string[];
  completion?: "admission" | "completed";
  credential?: RouteAutomationCredential;
}

export interface RouteOperationMetadata {
  description?: string;
  requestSchema?: unknown;
  querySchema?: unknown;
  responseSchema?: unknown;
  automation?: RouteAutomationMetadata;
  /** Default deny; an operation may explicitly override an inherited grant with false. */
  delegation?: RouteDelegationMetadata | false;
  partialResults?: PartialResultMetadata;
  /** Preserve a successful receipt when this operation intentionally invalidates its own actor. */
  actorInvalidation?: { userParameter: string };
}

export interface RouteMetadata extends RouteOperationMetadata {
  cliPath?: string;
  tags?: string[];
  operations?: Partial<Record<HttpMethod, RouteOperationMetadata>>;
  catalog?: boolean;
}

export function resolveRouteOperationMetadata(route: RouteMetadata, method: HttpMethod): RouteOperationMetadata {
  return {
    description: route.description,
    requestSchema: route.requestSchema,
    querySchema: route.querySchema,
    responseSchema: route.responseSchema,
    automation: route.automation,
    delegation: route.delegation,
    partialResults: route.partialResults,
    actorInvalidation: route.actorInvalidation,
    ...route.operations?.[method],
  };
}

export type RouteDefinition<TEvent = unknown> = {
  auth?: RouteAuth;
  sameOrigin?: SameOriginMode;
  scopes?: string[];
  userParam?: string;
} & RouteMetadata & Partial<Record<HttpMethod, WebAppRouteHandler<Record<string, string>, TEvent>>>;

export type RouteTable<TEvent = unknown> = Record<string, RouteDefinition<TEvent>>;

export function defineRoutes<TEvent = unknown>(routes: RouteTable<TEvent>): RouteTable<TEvent> {
  return routes;
}

export interface CompiledRoute<TEvent = unknown> {
  readonly pattern: string;
  readonly cliPath: string;
  readonly route: RouteDefinition<TEvent>;
  readonly patterns: CompiledRoutePatterns;
  readonly methods: readonly HttpMethod[];
  readonly specificity: number;
  readonly specificityKey: readonly number[];
}

export interface CompiledRouteTable<TEvent = unknown> {
  readonly routes: readonly CompiledRoute<TEvent>[];
}

export interface MatchedRoute<TEvent = unknown> {
  pattern: string;
  route: RouteDefinition<TEvent>;
  params: Record<string, string>;
}

export interface MatchedCompiledRoute<TEvent = unknown> {
  readonly compiled: CompiledRoute<TEvent>;
  readonly pattern: string;
  readonly route: RouteDefinition<TEvent>;
  readonly params: Record<string, string>;
}

export type CompiledRouteMatch<TEvent = unknown> =
  | {
      readonly kind: "matched";
      readonly match: MatchedCompiledRoute<TEvent>;
    }
  | {
      readonly kind: "invalid-encoding";
    }
  | {
      readonly kind: "no-match";
    };

// A table's key preserves its event type; erase only the heterogeneous cache.
const compiledRouteTables = new WeakMap<object, unknown>();

function validatePolicy<TEvent>(compiled: CompiledRoute<TEvent>): void {
  const { pattern, route, patterns, methods } = compiled;
  if (route.userParam !== undefined && !patterns.api.captures.some((capture) => capture.name === route.userParam)) {
    invalidRouteDefinition(pattern, `userParam "${route.userParam}" is not declared in the API path`);
  }
  for (const method of methods) {
    const metadata = resolveRouteOperationMetadata(route, method);
    const invalidation = metadata.actorInvalidation;
    if (invalidation && !patterns.api.captures.some((capture) => capture.name === invalidation.userParameter)) {
      invalidRouteDefinition(pattern, `actorInvalidation userParameter "${invalidation.userParameter}" is not declared in the API path`);
    }
    for (const header of metadata.automation?.execution?.requestHeaders ?? []) {
      if (header !== header.toLowerCase() || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(header)
        || ["authorization", "proxy-authorization", "cookie", "host", "origin", "referer",
          "content-type", "content-length", "connection", "forwarded"].includes(header)
        || header.startsWith("x-forwarded-") || header.startsWith("sec-")) {
        invalidRouteDefinition(pattern, `execution requestHeaders must not override authentication, origin or transport headers`);
      }
    }
  }
}

export function compileRouteTable<TEvent = unknown>(routes: RouteTable<TEvent>): CompiledRouteTable<TEvent> {
  const cached = compiledRouteTables.get(routes);
  if (cached) {
    return cached as CompiledRouteTable<TEvent>;
  }
  const compiled = compileCoreRouteTable(routes as never) as unknown as CompiledRouteTable<TEvent>;
  for (const route of compiled.routes) validatePolicy(route);
  compiledRouteTables.set(routes, compiled);
  return compiled;
}

export function matchCompiledRouteTable<TEvent>(
  compiledRoutes: CompiledRouteTable<TEvent>,
  pathname: string,
): CompiledRouteMatch<TEvent> {
  return matchCoreRouteTable(compiledRoutes as never, pathname) as unknown as CompiledRouteMatch<TEvent>;
}

export function matchRoute<TEvent>(routes: RouteTable<TEvent>, pathname: string): MatchedRoute<TEvent> | undefined {
  const result = matchCompiledRouteTable(compileRouteTable(routes), pathname);
  if (result.kind !== "matched") {
    return undefined;
  }
  return {
    pattern: result.match.pattern,
    route: result.match.route,
    params: result.match.params,
  };
}
