import type { CurrentUser } from "../contracts";
import type { MatchedRouteOperation } from "./delegation";

export interface AuthenticatedInvocation<TAuthorization = unknown> {
  actor: Readonly<CurrentUser>;
  operation: MatchedRouteOperation;
  authorization: TAuthorization;
}

/**
 * Server-code capability, not a credential or a public authentication mechanism.
 * The application must verify transport admission and grant each operation.
 */
export interface AuthenticatedDispatchOptions<TAuthorization extends object> {
  userId: string;
  /** Explicitly admit public/optional routes through the same account and operation checks. Defaults to private routes only. */
  allowPublic?: boolean;
  authorize: (
    operation: MatchedRouteOperation,
    request: Request,
  ) => TAuthorization | false | undefined | Promise<TAuthorization | false | undefined>;
  run?: (
    invocation: AuthenticatedInvocation<TAuthorization>,
    invoke: () => Promise<Response | undefined>,
  ) => Promise<Response | undefined>;
  onError?: (
    error: unknown,
    operation: MatchedRouteOperation,
  ) => Response | Promise<Response>;
}
