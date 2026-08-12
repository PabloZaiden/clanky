/**
 * Central SSH reliability policy shared by ACP and remote command transports.
 */

export const SSH_CONNECT_TIMEOUT_MS = 30_000;
export const SSH_CONNECTION_ATTEMPTS = 2;
export const SSH_SERVER_ALIVE_INTERVAL_SECONDS = 30;
export const SSH_SERVER_ALIVE_COUNT_MAX = 3;
export const SSH_CONNECTION_TIMEOUT_MS = 75_000;
export const SSH_MAX_CONCURRENT_HANDSHAKES = 4;

export interface SshReliabilityPolicy {
  connectTimeoutMs: number;
  connectTimeoutSeconds: number;
  connectionAttempts: number;
  serverAliveIntervalSeconds: number;
  serverAliveCountMax: number;
  connectionTimeoutMs: number;
  maxConcurrentHandshakes: number;
}

export function getSshReliabilityPolicy(): SshReliabilityPolicy {
  return {
    connectTimeoutMs: SSH_CONNECT_TIMEOUT_MS,
    connectTimeoutSeconds: Math.ceil(SSH_CONNECT_TIMEOUT_MS / 1_000),
    connectionAttempts: SSH_CONNECTION_ATTEMPTS,
    serverAliveIntervalSeconds: SSH_SERVER_ALIVE_INTERVAL_SECONDS,
    serverAliveCountMax: SSH_SERVER_ALIVE_COUNT_MAX,
    connectionTimeoutMs: SSH_CONNECTION_TIMEOUT_MS,
    maxConcurrentHandshakes: SSH_MAX_CONCURRENT_HANDSHAKES,
  };
}

export function buildSshConnectionKey(target: {
  hostname?: string;
  port?: number;
  username?: string;
  password?: string;
  identityFile?: string;
}): string {
  return JSON.stringify({
    hostname: target.hostname?.trim().toLowerCase() ?? "",
    port: target.port ?? 22,
    username: target.username?.trim().toLowerCase() ?? "",
    authMode: target.identityFile?.trim()
      ? "identity"
      : target.password?.trim()
        ? "password"
        : "agent",
    identityFile: target.identityFile?.trim() ?? "",
  });
}
