import type { CurrentUser } from "../../contracts";

export interface AccessTokenClaims {
  sub: string;
  username?: string;
  role?: string;
  jti: string;
  sid: string;
  clientId: string;
  scope: string;
}

export type AuthenticatedRequestState =
  | { kind: "anonymous" }
  | { kind: "delegated"; user: CurrentUser }
  | { kind: "server"; user: CurrentUser }
  // Browser identity; passkeyId proves this session completed WebAuthn.
  | { kind: "passkey"; user: CurrentUser; passkeyId?: string }
  | { kind: "api-key"; user: CurrentUser; apiKeyId: string; scopes: string[] }
  | { kind: "bearer"; user: CurrentUser; claims: AccessTokenClaims; clientTicket?: { kind: "websocket" | "resource"; origin: string | null } };

export class AuthError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "AuthError";
    this.code = code;
    this.status = status;
  }
}
