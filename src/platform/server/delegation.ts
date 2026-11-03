import type { CurrentUser } from "../contracts";
import type { HttpMethod, RouteAuth, RouteOperationMetadata } from "./routes";
import type { RouteDelegationMetadata } from "../contracts/delegation";

export type { RouteDelegationMetadata, RouteResourceReference } from "../contracts/delegation";

/** Canonical operation from the same compiled table used for ordinary HTTP. */
export interface MatchedRouteOperation {
  path: string;
  method: HttpMethod;
  params: Readonly<Record<string, string>>;
  auth: RouteAuth;
  scopes: readonly string[];
  metadata: Readonly<RouteOperationMetadata>;
}

export interface DelegatedOperation extends MatchedRouteOperation {
  delegation: Readonly<RouteDelegationMetadata>;
}

export interface DelegatedInvocation<TAuthorization = unknown> {
  actor: Readonly<CurrentUser>;
  operation: DelegatedOperation;
  authorization: TAuthorization;
}

/**
 * Only server code holding a verified principal may call delegated dispatch.
 * The approval is domain authority, not an alternate authenticated user.
 */
export interface DelegatedDispatchOptions<TAuthorization extends object> {
  actor: CurrentUser;
  authorize: (
    operation: DelegatedOperation,
    request: Request,
  ) => TAuthorization | false | undefined | Promise<TAuthorization | false | undefined>;
  /** Establish a typed application operation context (for example AsyncLocalStorage). */
  run?: (
    invocation: DelegatedInvocation<TAuthorization>,
    invoke: () => Promise<Response | undefined>,
  ) => Promise<Response | undefined>;
  /** Map application failures without replacing framework denials or input validation. */
  onError?: (
    error: unknown,
    operation: MatchedRouteOperation,
  ) => Response | Promise<Response>;
}
