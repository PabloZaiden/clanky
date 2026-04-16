/**
 * Server runtime configuration helpers.
 *
 * Reads host, port, and optional HTTP Basic auth settings from environment variables
 * so startup code can stay centralized and testable.
 */

import { isSameOriginCheckDisabled } from "./config";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
const DEFAULT_BASIC_AUTH_USERNAME = "ralpher";
export const DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS = 120;
const MAX_PORT = 65535;
const SAME_ORIGIN_DISABLED_MESSAGE =
  "Same-origin protection is disabled because RALPHER_DISABLE_SAME_ORIGIN_CHECK was set. Use this only for development setups where browser and backend origins intentionally differ.";

export interface BasicAuthConfig {
  enabled: boolean;
  username: string;
  password: string;
  usernameSource: "RALPHER_USERNAME" | "default";
}

export interface ServerRuntimeConfig {
  host: string;
  port: number;
  hostSource: "RALPHER_HOST" | "default";
  basicAuth: BasicAuthConfig;
  sameOriginProtection: {
    disabled: boolean;
  };
}

export type BunDevelopmentConfig = false | {
  hmr: true;
  console: true;
};

function getTrimmedEnv(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function parsePort(value: string | undefined): number {
  const trimmedValue = value?.trim() ?? "";
  if (!trimmedValue) {
    return DEFAULT_PORT;
  }

  if (!/^\d+$/.test(trimmedValue)) {
    throw new Error(`RALPHER_PORT must be an integer between 0 and ${String(MAX_PORT)}; received "${trimmedValue}".`);
  }

  const port = Number(trimmedValue);
  if (!Number.isInteger(port) || port < 0 || port > MAX_PORT) {
    throw new Error(`RALPHER_PORT must be an integer between 0 and ${String(MAX_PORT)}; received "${trimmedValue}".`);
  }

  return port;
}

export function getServerRuntimeConfig(): ServerRuntimeConfig {
  const hostFromEnv = getTrimmedEnv("RALPHER_HOST");
  const usernameFromEnv = getTrimmedEnv("RALPHER_USERNAME");
  const trimmedPassword = getTrimmedEnv("RALPHER_PASSWORD");
  const port = parsePort(process.env["RALPHER_PORT"]);

  return {
    host: hostFromEnv || DEFAULT_HOST,
    port,
    hostSource: hostFromEnv ? "RALPHER_HOST" : "default",
    basicAuth: {
      enabled: trimmedPassword.length > 0,
      username: usernameFromEnv || DEFAULT_BASIC_AUTH_USERNAME,
      password: trimmedPassword,
      usernameSource: usernameFromEnv ? "RALPHER_USERNAME" : "default",
    },
    sameOriginProtection: {
      disabled: isSameOriginCheckDisabled(),
    },
  };
}

export function getServerDevelopmentConfig(
  nodeEnv: string | undefined = process.env["NODE_ENV"],
): BunDevelopmentConfig {
  if (nodeEnv === "production") {
    return false;
  }

  return {
    hmr: true,
    console: true,
  };
}

export function getServerStartupMessages(config: ServerRuntimeConfig): string[] {
  const listenMessage = config.hostSource === "RALPHER_HOST"
    ? `Listening on http://${config.host}:${String(config.port)} from RALPHER_HOST. Change RALPHER_HOST to choose which interfaces accept requests.`
    : `Listening on http://${config.host}:${String(config.port)} using the default host because RALPHER_HOST was not set. Set RALPHER_HOST to the interface you want to bind (e.g. RALPHER_HOST=0.0.0.0 to listen on all interfaces).`;

  if (config.basicAuth.enabled) {
    const usernameMessage = config.basicAuth.usernameSource === "RALPHER_USERNAME"
      ? `using the username "${config.basicAuth.username}" from RALPHER_USERNAME`
      : `using the default username "${config.basicAuth.username}" because RALPHER_USERNAME was not set`;

    const messages = [
      listenMessage,
      `Basic auth is enabled because RALPHER_PASSWORD was set to a non-empty value after trimming, ${usernameMessage}.`,
    ];

    if (config.sameOriginProtection.disabled) {
      messages.push(SAME_ORIGIN_DISABLED_MESSAGE);
    }

    return messages;
  }

  const messages = [
    listenMessage,
    `Basic auth is disabled because RALPHER_PASSWORD was not set or became empty after trimming. Set RALPHER_PASSWORD to enable auth, and optionally set RALPHER_USERNAME to override the default username "${DEFAULT_BASIC_AUTH_USERNAME}".`,
  ];

  if (config.sameOriginProtection.disabled) {
    messages.push(SAME_ORIGIN_DISABLED_MESSAGE);
  }

  return messages;
}
