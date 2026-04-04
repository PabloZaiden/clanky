/**
 * Shared helpers for passkey-based application authentication.
 */

import { isPasskeyRequestAuthorized } from "../core/passkey-auth";
import { PASSKEY_AUTH_REQUIRED_HEADER } from "../lib/passkey-auth-http";

type MaybePromise<T> = T | Promise<T>;

type RouteLikeHandler<TArgs extends unknown[] = never[]> = (
  ...args: TArgs
) => MaybePromise<Response | undefined>;

type RouteLikeMethods = Record<string, (...args: never[]) => MaybePromise<Response>>;
type RouteLikeValue = RouteLikeMethods | RouteLikeHandler;

function createPasskeyUnauthorizedResponse(): Response {
  return Response.json(
    {
      error: "authentication_required",
      message: "Passkey authentication is required",
    },
    {
      status: 401,
      headers: {
        [PASSKEY_AUTH_REQUIRED_HEADER]: "true",
      },
    },
  );
}

function getRequestFromArgs(args: unknown[]): Request {
  const req = args[0];
  if (!(req instanceof Request)) {
    throw new Error("Passkey-authenticated Bun route handlers must receive a Request as their first argument");
  }
  return req;
}

export function wrapRouteHandlerWithPasskeyAuth<TArgs extends unknown[]>(
  handler: RouteLikeHandler<TArgs>,
): RouteLikeHandler<TArgs> {
  return async (...args: TArgs): Promise<Response | undefined> => {
    const req = getRequestFromArgs(args);
    if (!await isPasskeyRequestAuthorized(req)) {
      return createPasskeyUnauthorizedResponse();
    }
    return await handler(...args);
  };
}

function wrapRouteMethodsWithPasskeyAuth<TRoute extends RouteLikeMethods>(
  route: TRoute,
): TRoute {
  const wrappedRoute = {} as TRoute;

  for (const [method, handler] of Object.entries(route) as [keyof TRoute, TRoute[keyof TRoute]][]) {
    wrappedRoute[method] = (async (
      ...args: Parameters<TRoute[keyof TRoute]>
    ): Promise<Response> => {
      const req = getRequestFromArgs(args);
      if (!await isPasskeyRequestAuthorized(req)) {
        return createPasskeyUnauthorizedResponse();
      }
      return await handler(...args);
    }) as TRoute[keyof TRoute];
  }

  return wrappedRoute;
}

export function wrapRoutesWithPasskeyAuth<TRoutes extends Record<string, RouteLikeValue>>(
  routes: TRoutes,
  publicRoutePaths: ReadonlySet<string> = new Set(),
): TRoutes {
  const wrappedRoutes = {} as TRoutes;

  for (const [path, route] of Object.entries(routes) as [keyof TRoutes, TRoutes[keyof TRoutes]][]) {
    if (publicRoutePaths.has(String(path))) {
      wrappedRoutes[path] = route;
      continue;
    }

    wrappedRoutes[path] = typeof route === "function"
      ? wrapRouteHandlerWithPasskeyAuth(route) as TRoutes[keyof TRoutes]
      : wrapRouteMethodsWithPasskeyAuth(route) as TRoutes[keyof TRoutes];
  }

  return wrappedRoutes;
}
