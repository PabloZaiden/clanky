/**
 * Central SSH reliability policy shared by ACP and remote command transports.
 */

export const DEFAULT_SSH_CONNECT_TIMEOUT_MS = 30_000;
export const DEFAULT_SSH_CONNECTION_ATTEMPTS = 2;
export const DEFAULT_SSH_SERVER_ALIVE_INTERVAL_SECONDS = 30;
export const DEFAULT_SSH_SERVER_ALIVE_COUNT_MAX = 3;
export const DEFAULT_SSH_CONNECTION_TIMEOUT_MS = 75_000;
export const DEFAULT_SSH_MAX_CONCURRENT_HANDSHAKES = 4;
export const SSH_CONNECTION_STARTUP_GRACE_MS = 15_000;

export interface SshReliabilityPolicy {
  connectTimeoutMs: number;
  connectTimeoutSeconds: number;
  connectionAttempts: number;
  serverAliveIntervalSeconds: number;
  serverAliveCountMax: number;
  connectionTimeoutMs: number;
  maxConcurrentHandshakes: number;
}

function readIntegerEnv(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const rawValue = process.env[name]?.trim();
  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}; received '${rawValue}'`,
    );
  }
  return value;
}

export function getSshReliabilityPolicy(): SshReliabilityPolicy {
  const connectTimeoutMs = readIntegerEnv(
    "CLANKY_SSH_CONNECT_TIMEOUT_MS",
    DEFAULT_SSH_CONNECT_TIMEOUT_MS,
    1_000,
    300_000,
  );
  const connectionAttempts = readIntegerEnv(
    "CLANKY_SSH_CONNECTION_ATTEMPTS",
    DEFAULT_SSH_CONNECTION_ATTEMPTS,
    1,
    5,
  );
  const connectTimeoutSeconds = Math.ceil(connectTimeoutMs / 1_000);
  const minimumConnectionTimeoutMs =
    connectTimeoutSeconds * 1_000 * connectionAttempts + SSH_CONNECTION_STARTUP_GRACE_MS;
  const configuredConnectionTimeoutMs = process.env["CLANKY_SSH_CONNECTION_TIMEOUT_MS"]?.trim();
  const connectionTimeoutMs = configuredConnectionTimeoutMs
    ? readIntegerEnv(
        "CLANKY_SSH_CONNECTION_TIMEOUT_MS",
        DEFAULT_SSH_CONNECTION_TIMEOUT_MS,
        minimumConnectionTimeoutMs,
        1_800_000,
      )
    : Math.max(DEFAULT_SSH_CONNECTION_TIMEOUT_MS, minimumConnectionTimeoutMs);

  return {
    connectTimeoutMs,
    connectTimeoutSeconds,
    connectionAttempts,
    serverAliveIntervalSeconds: readIntegerEnv(
      "CLANKY_SSH_SERVER_ALIVE_INTERVAL_SECONDS",
      DEFAULT_SSH_SERVER_ALIVE_INTERVAL_SECONDS,
      0,
      600,
    ),
    serverAliveCountMax: readIntegerEnv(
      "CLANKY_SSH_SERVER_ALIVE_COUNT_MAX",
      DEFAULT_SSH_SERVER_ALIVE_COUNT_MAX,
      1,
      10,
    ),
    connectionTimeoutMs,
    maxConcurrentHandshakes: readIntegerEnv(
      "CLANKY_SSH_MAX_CONCURRENT_HANDSHAKES",
      DEFAULT_SSH_MAX_CONCURRENT_HANDSHAKES,
      1,
      64,
    ),
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
