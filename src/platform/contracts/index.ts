export * from "@pablozaiden/webapp/contracts";
export {
  WEB_APP_CLIENT_CONFIG_PATH,
  webAppClientBootstrapSchema,
  type WebAppClientBootstrap,
} from "./client-bootstrap";
export * from "./delegation";
import type { WebAppConfigResponse as CoreConfigResponse } from "@pablozaiden/webapp/contracts";

export type WebAppUserRole = "owner" | "admin" | "user";

export interface CurrentUser {
  id: string;
  username: string;
  role: WebAppUserRole;
  isOwner: boolean;
  isAdmin: boolean;
}

export interface WebAppUserSummary {
  id: string;
  username: string;
  role: WebAppUserRole;
  passkeyConfigured: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

export interface UserSetupLinkResponse {
  url: string;
  expiresAt: string;
}

export interface CreatedUserResponse {
  user: WebAppUserSummary;
  setupLink: UserSetupLinkResponse;
}

export interface UserSetupDetails {
  username: string;
  role: WebAppUserRole;
  kind: "invite" | "reset";
  expiresAt: string;
}

export interface AuditEventSummary {
  id: string;
  eventType: string;
  actorUserId?: string;
  targetUserId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface PasskeyAuthStatusResponse {
  enabled: boolean;
  passkeyConfigured: boolean;
  accountPasskeyConfigured: boolean;
  passkeyDisabled: boolean;
  passkeyRequired: boolean;
  authenticated: boolean;
  bootstrapRequired: boolean;
  ownerPasskeySetupRequired: boolean;
  passkeyAvailable: boolean;
  passwordEnabled: boolean;
}

export interface PasswordLoginRequest {
  username: string;
  password: string;
}

export interface PasswordEnrollmentRequest {
  password: string;
}

export interface PasswordChangeRequest {
  currentPassword: string;
  nextPassword: string;
}

export interface PasswordStatusResponse {
  configured: boolean;
}

export type ApiKeyKind = "user" | "managed";

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt?: string;
  expiresAt?: string;
}

export interface CreatedApiKeyResponse {
  key: ApiKeySummary;
  token: string;
}

export interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceVerificationDetails {
  userCode: string;
  clientId: string;
  scope: string;
  status: "pending" | "approved" | "denied" | "consumed" | "expired";
  expiresAt: string;
  passkeyRequired: boolean;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
}

export interface ClientTicketRequest {
  /** Application-relative /api/ path and query, without a deployment prefix. */
  url: string;
  kind: "websocket" | "resource";
}

export interface ClientTicketResponse {
  /** Short-lived capability URL, relative to the configured API base. */
  url: string;
  /** Expiration in milliseconds since the Unix epoch. */
  expiresAt: number;
}

export interface AuthSessionSummary {
  id: string;
  clientId: string;
  scope: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  /** Built-in session lists only expose active sessions; retained for API compatibility. */
  active: boolean;
}

export interface WebAppConfigResponse extends CoreConfigResponse {
  web?: { mode: "app" | "auth" | "disabled" };
  currentUser?: CurrentUser;
  passkeyAuth: PasskeyAuthStatusResponse;
  userManagement: {
    enabled: boolean;
    canManageUsers: boolean;
  };
  /** Legacy field name retained for temporary server-log capture. */
  inMemoryLogs: {
    enabled: boolean;
  };
  deviceAuth: {
    enabled: boolean;
  };
  apiKeys: {
    enabled: boolean;
  };
}
