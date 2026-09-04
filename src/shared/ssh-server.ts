/**
 * Standalone SSH server and credential domain types.
 */

import type {
  TerminalConnectionMode,
  TerminalSessionState,
} from "./terminal-session";
import type { ExecutionHostBinding } from "./execution-host";

export type SshKeyAlgorithm = "RSA-OAEP-256";

/**
 * Persisted standalone SSH server metadata.
 *
 * This is the only server-side metadata intended to be stored for the
 * standalone SSH server registry.
 */
export interface SshServerConfig {
  id: string;
  name: string;
  address: string;
  /** SSH port. Older persisted records default to 22. */
  port?: number;
  username: string;
  /** Default base path for cloning repositories on the remote host. */
  repositoriesBasePath: string | null;
  createdAt: string;
  updatedAt: string;
  isPrivate?: boolean;
}

/**
 * Public key metadata exposed to the browser for local password encryption.
 */
export interface SshServerPublicKey {
  algorithm: SshKeyAlgorithm;
  publicKey: string;
  fingerprint: string;
  version: number;
  createdAt: string;
}

/**
 * Combined standalone SSH server object returned by the API.
 */
export interface SshServer {
  config: SshServerConfig;
  publicKey: SshServerPublicKey;
}

export interface DevboxTemplateSummary {
  name: string;
  description: string;
  source: "built-in";
  base: string;
  image: string | null;
  pinnedReference: string;
  runtimeVersion: string;
  languages: string[];
  runnerCompatible: boolean;
}

/**
 * Browser-stored encrypted SSH password payload.
 */
export interface SshServerEncryptedCredential {
  algorithm: SshKeyAlgorithm;
  fingerprint: string;
  version: number;
  ciphertext: string;
}

/**
 * Short-lived credential exchange result used by session creation and terminal
 * connection flows.
 */
export interface SshCredentialExchangeResponse {
  credentialToken: string;
  expiresAt: string;
}

/**
 * Standalone SSH session configuration.
 */
export interface SshServerSessionConfig {
  id: string;
  name: string;
  sshServerId: string;
  connectionMode: TerminalConnectionMode;
  useTmux: boolean;
  remoteSessionName: string;
  createdAt: string;
  updatedAt: string;
  isPrivate?: boolean;
}

/**
 * Standalone SSH session backed by a registered SSH server rather than a
 * workspace. These can use persistent or direct SSH.
 */
export interface SshServerSession {
  config: SshServerSessionConfig;
  state: TerminalSessionState;
}

export type VncSessionStatus =
  | "starting"
  | "active"
  | "stopping"
  | "stopped"
  | "failed";

export interface VncSessionConfig {
  id: string;
  sshServerId?: string;
  /** Canonical execution host snapshot retained alongside the legacy SSH ID. */
  executionHostBinding?: ExecutionHostBinding | null;
  remoteHost: "127.0.0.1";
  remotePort: number;
  localPort: number;
  createdAt: string;
  updatedAt: string;
}

export interface VncSessionState {
  status: VncSessionStatus;
  pid?: number;
  connectedAt?: string;
  error?: string;
}

export interface VncSession {
  config: VncSessionConfig;
  state: VncSessionState;
}

export type SshServerPrerequisiteId =
  | "ssh_connection"
  | "bash"
  | "dtach"
  | "devbox"
  | "docker"
  | "devcontainer"
  | "git"
  | "gh";

export type SshServerPrerequisiteStatus =
  | "available"
  | "missing"
  | "not_applicable"
  | "unknown";

export type SshServerPrerequisiteSummaryStatus =
  | "ready"
  | "missing_requirements"
  | "connection_failed";

export interface SshServerPrerequisiteCheck {
  id: SshServerPrerequisiteId;
  label: string;
  status: SshServerPrerequisiteStatus;
  details: string;
  requiredFor: string[];
  installHint?: string;
}

export interface SshServerPrerequisiteReport {
  serverId: string;
  checkedAt: string;
  summary: {
    status: SshServerPrerequisiteSummaryStatus;
    availableCount: number;
    missingCount: number;
    notApplicableCount: number;
    unknownCount: number;
  };
  checks: SshServerPrerequisiteCheck[];
}
