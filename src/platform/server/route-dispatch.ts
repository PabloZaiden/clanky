import type { Server } from "bun";
import { assertScopes } from "./auth/api-keys";
import { AuthError } from "./auth/types";
import type { AuthenticatedRequestState } from "./auth/types";
import type { DelegatedDispatchOptions, DelegatedInvocation, DelegatedOperation, MatchedRouteOperation } from "./delegation";
import type { AuthenticatedDispatchOptions, AuthenticatedInvocation } from "./authenticated-dispatch";
import type { CurrentUser } from "../contracts";
import { authErrorResponse, enforceRouteAuth, requiresAuth, scopesFromBearer, type Authentication } from "./authentication";
import type { RuntimeConfig } from "./runtime-config";
import { createLogger } from "@pablozaiden/webapp/server";
import { checkSameOrigin } from "./same-origin";
import type { RealtimeBus } from "@pablozaiden/webapp/server";
import { invalidPath, errorResponse, requestBodyErrorResponse, methodNotAllowed, responseForRequest, withSecurityHeaders } from "@pablozaiden/webapp/server";
import { matchCompiledRouteTable, resolveRouteOperationMetadata, type CompiledRouteTable, type HttpMethod, type RouteContext, type UserScopedRealtimePublisher, type WebAppRouteMiddleware } from "./routes";
import type { WebAppWebSocketData } from "./server-types";

export interface RouteDispatchResult {
  matched: boolean;
  response?: Response;
}

export interface RouteDispatcherDependencies<TEvent = unknown> {
  config: RuntimeConfig;
  routes: CompiledRouteTable<TEvent>;
  authentication: Authentication;
  realtime: RealtimeBus<TEvent>;
  middleware?: WebAppRouteMiddleware<TEvent>;
}

const log = createLogger("webapp:routes");

function method(req: Request): HttpMethod | undefined {
  switch (req.method.toUpperCase()) {
    case "GET":
      return "GET";
    case "POST":
      return "POST";
    case "PUT":
      return "PUT";
    case "PATCH":
      return "PATCH";
    case "DELETE":
      return "DELETE";
    default:
      return undefined;
  }
}

function frameworkRouteErrorResponse(error: unknown): Response | undefined {
  const requestBodyFailure = requestBodyErrorResponse(error);
  if (requestBodyFailure) {
    return requestBodyFailure;
  }
  if (error instanceof AuthError) {
    return errorResponse(error.status, error.code, error.message);
  }
  return undefined;
}

function failedRequest(): Response {
  return errorResponse(500, "request_failed", "Request failed");
}

function routeHandlerErrorResponse(error: unknown): Response {
  const frameworkFailure = frameworkRouteErrorResponse(error);
  if (frameworkFailure) return frameworkFailure;
  log.error("Unhandled route handler error", { error: error instanceof Error ? error.message : String(error) });
  return failedRequest();
}

async function admittedErrorResponse<TAuthorization extends object>(
  error: unknown,
  operation: MatchedRouteOperation,
  options: Pick<DelegatedDispatchOptions<TAuthorization>, "onError">,
): Promise<Response> {
  const frameworkFailure = frameworkRouteErrorResponse(error);
  if (frameworkFailure) return frameworkFailure;
  if (!options.onError) return routeHandlerErrorResponse(error);
  try {
    const response = await options.onError(error, operation);
    if (!(response instanceof Response)) throw new TypeError("Admitted onError must return a Response");
    return response;
  } catch {
    // Error hooks may fail while handling private domain or credential data.
    log.error("Admitted application error hook failed", { path: operation.path, method: operation.method });
    return failedRequest();
  }
}

function routeResponse(req: Request, response: Response): Response {
  return responseForRequest(req, withSecurityHeaders(response));
}

export function createRouteDispatcher<TEvent = unknown>(dependencies: RouteDispatcherDependencies<TEvent>) {
  const { config, routes, authentication, realtime } = dependencies;

  return {
    async dispatch<TAuthorization extends object>(
      req: Request,
      server?: Server<WebAppWebSocketData>,
      delegated?: DelegatedDispatchOptions<TAuthorization>,
      authenticated?: AuthenticatedDispatchOptions<TAuthorization> & { actor: CurrentUser; validateActor: () => boolean },
    ): Promise<RouteDispatchResult> {
      const routeMatch = matchCompiledRouteTable(routes, new URL(req.url).pathname);
      if (routeMatch.kind === "no-match") {
        return { matched: false };
      }
      if (routeMatch.kind === "invalid-encoding") {
        return { matched: true, response: routeResponse(req, invalidPath()) };
      }
      const matched = routeMatch.match;
      const requestMethod = req.method.toUpperCase() === "HEAD" ? "GET" : method(req);
      const handler = req.method.toUpperCase() === "HEAD"
        ? matched.route.GET
        : requestMethod
          ? matched.route[requestMethod]
          : undefined;
      if (!handler) {
        return { matched: true, response: routeResponse(req, methodNotAllowed(matched.compiled.methods)) };
      }
      const routeAuth = matched.route.auth ?? "required";
      const operation: MatchedRouteOperation = Object.freeze({
        path: matched.pattern,
        method: requestMethod!,
        params: Object.freeze({ ...matched.params }),
        auth: routeAuth,
        scopes: Object.freeze([...(matched.route.scopes ?? [])]),
        metadata: Object.freeze(resolveRouteOperationMetadata(matched.route, requestMethod!)),
      });
      const auth: AuthenticatedRequestState | Response = delegated
        ? { kind: "delegated", user: Object.freeze({ ...delegated.actor }) }
        : authenticated
        ? { kind: "server", user: authenticated.actor }
        : await authentication.authorize(req, requiresAuth(routeAuth));
      if (auth instanceof Response) {
        return { matched: true, response: routeResponse(req, auth) };
      }
      let delegation: DelegatedInvocation<TAuthorization> | undefined;
      let invocation: AuthenticatedInvocation<TAuthorization> | undefined;
      const admitted = delegated ?? authenticated;
      try {
        if (delegated) {
          const metadata = operation.metadata.delegation;
          if (
            !metadata || !metadata.resource || !metadata.action || (routeAuth !== "user" && routeAuth !== "required")
            || auth.kind !== "delegated" || !auth.user.id
            || auth.user.role !== "user" || auth.user.isAdmin || auth.user.isOwner
          ) {
            throw new AuthError("delegation_forbidden", "This operation does not permit delegated access", 403);
          }
          const delegatedOperation: DelegatedOperation = Object.freeze({
            ...operation,
            delegation: Object.freeze({
              ...metadata,
              bindings: metadata.bindings?.map(reference => Object.freeze({ ...reference })),
            }),
          });
          const authorization = await delegated.authorize(delegatedOperation, req);
          if (!authorization || typeof authorization !== "object") {
            throw new AuthError("delegation_forbidden", "Delegated access was not granted", 403);
          }
          delegation = Object.freeze({ actor: auth.user, operation: delegatedOperation, authorization });
        }
        enforceRouteAuth(routeAuth, auth, authentication);
        if (authenticated) {
          if ((routeAuth === "public" || routeAuth === "optional") && !authenticated.allowPublic) {
            throw new AuthError("authorization_forbidden", "Authenticated dispatch requires a private operation", 403);
          }
          const authorization = await authenticated.authorize(operation, req);
          if (!authenticated.validateActor()) {
            throw new AuthError("authentication_required", "Account authorization changed", 403);
          }
          if (!authorization || typeof authorization !== "object") {
            throw new AuthError("authorization_forbidden", "Operation access was not granted", 403);
          }
          invocation = Object.freeze({ actor: authenticated.actor, operation, authorization });
        }
        if (matched.route.userParam) {
          const paramValue = matched.params[matched.route.userParam];
          if (!paramValue) {
            throw new AuthError("route_misconfigured", `Route userParam "${matched.route.userParam}" is missing from matched params`, 500);
          }
          authentication.assertUser(auth, paramValue);
        }
        if (routeAuth !== "public" && (auth.kind === "api-key" || auth.kind === "bearer")) {
          assertScopes(auth.kind === "api-key" ? auth.scopes : scopesFromBearer(auth.claims), matched.route.scopes ?? []);
        }
      } catch (error) {
        const response = admitted
          ? await admittedErrorResponse(error, operation, admitted)
          : authErrorResponse(error);
        return { matched: true, response: routeResponse(req, response) };
      }
      const current = () => authentication.requireUser(auth);
      const userRealtime = {
        publishChanged: (resource, options = {}) => realtime.publishChanged(resource, { ...options, target: { ...options.target, userId: current().id } }),
        publishEntityChanged: (resource, id, options = {}) => realtime.publishEntityChanged(resource, id, { ...options, target: { ...options.target, userId: current().id } }),
        publishDeleted: (resource, id, options = {}) => realtime.publishDeleted(resource, id, { ...options, target: { ...options.target, userId: current().id } }),
        publishSettingsChanged: (options = {}) => realtime.publishSettingsChanged({ ...options, target: { ...options.target, userId: current().id } }),
      } satisfies UserScopedRealtimePublisher<TEvent>;
      // Trusted transport admission is a server-code capability, not browser credentials.
      // The verified transport replaces the browser origin check only on this path.
      const originFailure = admitted ? undefined : checkSameOrigin(req, config, auth, matched.route.sameOrigin ?? "mutations");
      if (originFailure) {
        return { matched: true, response: routeResponse(req, originFailure) };
      }
      try {
        const context: RouteContext<Record<string, string>, TEvent> = {
          params: matched.params,
          auth,
          user: authentication.currentUser(auth),
          delegation,
          requireUser: () => authentication.requireUser(auth),
          requireAdmin: () => authentication.requireAdmin(auth),
          requireOwner: () => authentication.requireOwner(auth),
          assertUser: (userId) => authentication.assertUser(auth, userId),
          filterOwned: authentication.createFilterOwned(auth),
          requireOwned: authentication.createRequireOwned(auth),
          realtime,
          userRealtime,
          server,
        };
        const assertActor = () => {
          if (authenticated && !authenticated.validateActor()) {
            throw new AuthError("authentication_required", "Account authorization changed", 403);
          }
        };
        const invoke = async () => {
          assertActor();
          return await handler(req, context);
        };
        const execute = async () => {
          assertActor();
          return dependencies.middleware
            ? await dependencies.middleware(req, context, operation, invoke)
            : await invoke();
        };
        const response = delegated?.run && delegation
          ? await delegated.run(delegation, execute)
          : authenticated?.run && invocation
          ? await authenticated.run(invocation, execute)
          : await execute();
        const invalidation = operation.metadata.actorInvalidation;
        const ownInvalidation = response?.ok && authenticated && invalidation
          && operation.params[invalidation.userParameter] === authenticated.actor.id;
        if (!ownInvalidation) assertActor();
        return { matched: true, response: response ? routeResponse(req, response) : undefined };
      } catch (error) {
        const response = admitted
          ? await admittedErrorResponse(error, operation, admitted)
          : routeHandlerErrorResponse(error);
        return { matched: true, response: routeResponse(req, response) };
      }
    },
  };
}
