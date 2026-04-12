/**
 * Shared helpers for same-origin protection on state-changing requests.
 */

import { checkRequestSameOrigin } from "../utils/request-origin";
import { errorResponse } from "./helpers";

type MaybePromise<T> = T | Promise<T>;

type RouteLikeHandler<TArgs extends unknown[] = never[]> = (
  ...args: TArgs
) => MaybePromise<Response | undefined>;

type RouteLikeMethods = Record<string, (...args: never[]) => MaybePromise<Response>>;
type RouteLikeValue = RouteLikeMethods | RouteLikeHandler;

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function getRequestFromArgs(args: unknown[]): Request {
  const req = args[0];
  if (!(req instanceof Request)) {
    throw new Error("Same-origin-protected Bun route handlers must receive a Request as their first argument");
  }
  return req;
}

function createSameOriginForbiddenResponse(): Response {
  return errorResponse(
    "invalid_request_origin",
    "Origin or Referer must match the request origin",
    403,
  );
}

function shouldProtectRequest(req: Request, alwaysProtect: boolean): boolean {
  return alwaysProtect
    || MUTATING_METHODS.has(req.method.toUpperCase())
    || req.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function requireSameOrigin(req: Request, alwaysProtect = false): Response | undefined {
  if (!shouldProtectRequest(req, alwaysProtect)) {
    return undefined;
  }

  const result = checkRequestSameOrigin(req);
  if (result.allowed) {
    return undefined;
  }

  return createSameOriginForbiddenResponse();
}

export function wrapRouteHandlerWithSameOriginProtection<TArgs extends unknown[]>(
  handler: RouteLikeHandler<TArgs>,
  options: { alwaysProtect?: boolean } = {},
): RouteLikeHandler<TArgs> {
  return async (...args: TArgs): Promise<Response | undefined> => {
    const req = getRequestFromArgs(args);
    const rejection = requireSameOrigin(req, options.alwaysProtect ?? false);
    if (rejection) {
      return rejection;
    }
    return await handler(...args);
  };
}

function wrapRouteMethodsWithSameOriginProtection<TRoute extends RouteLikeMethods>(
  route: TRoute,
): TRoute {
  const wrappedRoute = {} as TRoute;

  for (const [method, handler] of Object.entries(route) as [keyof TRoute, TRoute[keyof TRoute]][]) {
    wrappedRoute[method] = (async (
      ...args: Parameters<TRoute[keyof TRoute]>
    ): Promise<Response> => {
      const req = getRequestFromArgs(args);
      const rejection = requireSameOrigin(req);
      if (rejection) {
        return rejection;
      }
      return await handler(...args);
    }) as TRoute[keyof TRoute];
  }

  return wrappedRoute;
}

export function wrapRoutesWithSameOriginProtection<TRoutes extends Record<string, RouteLikeValue>>(
  routes: TRoutes,
): TRoutes {
  const wrappedRoutes = {} as TRoutes;

  for (const [path, route] of Object.entries(routes) as [keyof TRoutes, TRoutes[keyof TRoutes]][]) {
    wrappedRoutes[path] = typeof route === "function"
      ? wrapRouteHandlerWithSameOriginProtection(route) as TRoutes[keyof TRoutes]
      : wrapRouteMethodsWithSameOriginProtection(route) as TRoutes[keyof TRoutes];
  }

  return wrappedRoutes;
}
