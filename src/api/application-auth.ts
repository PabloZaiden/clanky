/**
 * Shared helpers for application-level authentication.
 *
 * A request is authorized when:
 * - a valid bearer token is present, or
 * - passkey auth is required and the browser has a valid passkey session, or
 * - passkey auth is not required for the current instance.
 */

import { isPasskeyAuthRequired, isPasskeySessionAuthenticated } from "../core/passkey-auth";
import { validateAccessToken, type AccessTokenClaims, AuthError } from "../core/token-auth";
import { PASSKEY_AUTH_REQUIRED_HEADER } from "../lib/passkey-auth-http";

type MaybePromise<T> = T | Promise<T>;

type RouteLikeHandler<TArgs extends unknown[] = never[]> = (
  ...args: TArgs
) => MaybePromise<Response | undefined>;

type RouteLikeMethods = Record<string, (...args: never[]) => MaybePromise<Response>>;
type RouteLikeValue = RouteLikeMethods | RouteLikeHandler;

export interface AuthenticatedRequestState {
  kind: "anonymous" | "passkey" | "bearer";
  claims?: AccessTokenClaims;
}

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

function createInvalidBearerResponse(error: AuthError): Response {
  return Response.json(
    {
      error: error.code,
      message: error.message,
    },
    { status: error.status },
  );
}

function getRequestFromArgs(args: unknown[]): Request {
  const req = args[0];
  if (!(req instanceof Request)) {
    throw new Error("Authenticated Bun route handlers must receive a Request as their first argument");
  }
  return req;
}

async function authorizeRequest(req: Request): Promise<{
  state?: AuthenticatedRequestState;
  response?: Response;
}> {
  const authorizationHeader = req.headers.get("authorization")?.trim();
  if (authorizationHeader) {
    const [scheme, token] = authorizationHeader.split(/\s+/, 2);
    if (scheme?.toLowerCase() === "bearer") {
      if (!token) {
        return {
          response: Response.json(
            { error: "invalid_token", message: "Authorization header must use the Bearer scheme" },
            { status: 401 },
          ),
        };
      }

      try {
        const claims = await validateAccessToken(token);
        return {
          state: {
            kind: "bearer",
            claims,
          },
        };
      } catch (error) {
        if (error instanceof AuthError) {
          return {
            response: createInvalidBearerResponse(error),
          };
        }
        throw error;
      }
    }
  }

  if (await isPasskeyAuthRequired()) {
    if (!await isPasskeySessionAuthenticated(req)) {
      return {
        response: createPasskeyUnauthorizedResponse(),
      };
    }

    return {
      state: {
        kind: "passkey",
      },
    };
  }

  return {
    state: {
      kind: "anonymous",
    },
  };
}

export async function authorizeApplicationRequest(req: Request): Promise<{
  state?: AuthenticatedRequestState;
  response?: Response;
}> {
  return await authorizeRequest(req);
}

export async function getApplicationAuthState(req: Request): Promise<AuthenticatedRequestState> {
  const { state, response } = await authorizeApplicationRequest(req);
  if (response || !state) {
    throw new Error("Application auth state requested for an unauthorized request");
  }
  return state;
}

export function wrapRouteHandlerWithApplicationAuth<TArgs extends unknown[]>(
  handler: RouteLikeHandler<TArgs>,
): RouteLikeHandler<TArgs> {
  return async (...args: TArgs): Promise<Response | undefined> => {
    const req = getRequestFromArgs(args);
    const { response } = await authorizeApplicationRequest(req);
    if (response) {
      return response;
    }
    return await handler(...args);
  };
}

function wrapRouteMethodsWithApplicationAuth<TRoute extends RouteLikeMethods>(
  route: TRoute,
): TRoute {
  const wrappedRoute = {} as TRoute;

  for (const [method, handler] of Object.entries(route) as [keyof TRoute, TRoute[keyof TRoute]][]) {
    wrappedRoute[method] = (async (
      ...args: Parameters<TRoute[keyof TRoute]>
    ): Promise<Response> => {
      const req = getRequestFromArgs(args);
      const { response } = await authorizeApplicationRequest(req);
      if (response) {
        return response;
      }
      return await handler(...args);
    }) as TRoute[keyof TRoute];
  }

  return wrappedRoute;
}

export function wrapRoutesWithApplicationAuth<TRoutes extends Record<string, RouteLikeValue>>(
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
      ? wrapRouteHandlerWithApplicationAuth(route) as TRoutes[keyof TRoutes]
      : wrapRouteMethodsWithApplicationAuth(route) as TRoutes[keyof TRoutes];
  }

  return wrappedRoutes;
}
