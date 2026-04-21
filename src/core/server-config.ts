/**
 * Server runtime configuration helpers.
 *
 * Reads host and port settings from environment variables so startup code can
 * stay centralized and testable.
 */

import { isSameOriginCheckDisabled } from "./config";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3000;
export const DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS = 120;
const MAX_PORT = 65535;
const SAME_ORIGIN_DISABLED_MESSAGE =
  "Same-origin protection is disabled because RALPHER_DISABLE_SAME_ORIGIN_CHECK was set. Use this only for development setups where browser and backend origins intentionally differ.";

export interface ServerRuntimeConfig {
  host: string;
  port: number;
  hostSource: "RALPHER_HOST" | "default";
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
  const port = parsePort(process.env["RALPHER_PORT"]);

  return {
    host: hostFromEnv || DEFAULT_HOST,
    port,
    hostSource: hostFromEnv ? "RALPHER_HOST" : "default",
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

  const messages = [listenMessage];

  if (config.sameOriginProtection.disabled) {
    messages.push(SAME_ORIGIN_DISABLED_MESSAGE);
  }

  return messages;
}
