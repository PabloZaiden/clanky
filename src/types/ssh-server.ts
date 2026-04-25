/**
 * Standalone SSH server and credential domain types.
 */

import type { SshSessionBaseConfig, SshSessionState } from "./ssh-session";

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
  username: string;
  /** Default base path for cloning repositories on the remote host. */
  repositoriesBasePath: string | null;
  createdAt: string;
  updatedAt: string;
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
export interface SshServerSessionConfig extends SshSessionBaseConfig {
  sshServerId: string;
}

/**
 * Standalone SSH session backed by a registered SSH server rather than a
 * workspace. Like workspace SSH sessions, these can use persistent or direct SSH.
 */
export interface SshServerSession {
  config: SshServerSessionConfig;
  state: SshSessionState;
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
