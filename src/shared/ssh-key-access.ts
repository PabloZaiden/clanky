import type { ExecutionHostBinding, ExecutionHostRef } from "./execution-host";

export const MESH_SSH_AGENT_VERSION = 1;
export const MESH_SSH_AGENT_CONTEXT_VERSION = 1;
export const MESH_SSH_AGENT_HEADER = "x-clanky-mesh-ssh-agent";
export const MESH_SSH_AGENT_PATH = "/api/mesh/internal/ssh-agent";
export const SSH_AGENT_MAX_FRAME_BYTES = 256 * 1024;
export const SSH_AGENT_MAX_KEY_BYTES = 16 * 1024;

export interface SshAgentIdentity {
  publicKey: string;
  fingerprint: string;
  comment: string;
}

export interface SshKeySource {
  id: string;
  name: string;
  host: ExecutionHostRef;
  createdAt: string;
}

export interface SshPublicKey extends SshAgentIdentity {
  id: string;
  sourceId: string;
  alias: string;
  createdAt: string;
}

export interface WorkspaceSshKeyGrant {
  keyId: string;
  enabled: boolean;
}

export interface WorkspaceSshKeyAccess {
  keys: SshPublicKey[];
  sources: SshKeySource[];
  grants: WorkspaceSshKeyGrant[];
}

export type SshKeyAccessTarget =
  | { kind: "workspace"; id: string }
  | { kind: "host"; host: ExecutionHostRef };

export interface SshAgentContext {
  userId: string;
  target: SshKeyAccessTarget;
  binding: ExecutionHostBinding;
}
