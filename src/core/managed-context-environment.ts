/**
 * Builds the environment contract exposed to Clanky-managed runtimes.
 */

import type { ManagedRuntimeCredential } from "./managed-credential-service";

export interface ManagedContextEnvironment extends Record<string, string> {
  CLANKY_BASE_URL: string;
  CLANKY_API_KEY: string;
}

const MANAGED_CONTEXT_ENVIRONMENT_KEYS = new Set([
  "CLANKY_BASE_URL",
  "CLANKY_API_KEY",
]);

export function buildManagedContextEnvironment(
  credential?: Pick<ManagedRuntimeCredential, "baseUrl" | "token">,
): ManagedContextEnvironment | undefined {
  if (!credential) {
    return undefined;
  }

  return {
    CLANKY_BASE_URL: credential.baseUrl,
    CLANKY_API_KEY: credential.token,
  };
}

export function mergeRuntimeEnvironment(
  baseEnvironment?: Record<string, string | undefined>,
  managedEnvironment?: Record<string, string | undefined>,
): Record<string, string> | undefined {
  if (!baseEnvironment && !managedEnvironment) {
    return undefined;
  }

  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnvironment ?? {})) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  for (const [key, value] of Object.entries(managedEnvironment ?? {})) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

export function withoutManagedContextEnvironment(
  environment?: Record<string, string | undefined>,
): Record<string, string> | undefined {
  if (!environment) {
    return undefined;
  }

  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!MANAGED_CONTEXT_ENVIRONMENT_KEYS.has(key) && value !== undefined) {
      filtered[key] = value;
    }
  }
  return Object.keys(filtered).length > 0 ? filtered : undefined;
}

export function buildManagedContextShellBootstrap(
  environment: Record<string, string | undefined> | undefined,
  command: string,
): string {
  const baseUrl = environment?.["CLANKY_BASE_URL"];
  const token = environment?.["CLANKY_API_KEY"];
  if (!baseUrl || !token) {
    return command;
  }

  return [
    "stty -echo 2>/dev/null || true;",
    "IFS= read -r clanky_base_url;",
    "IFS= read -r clanky_api_key;",
    "stty echo 2>/dev/null || true;",
    "export CLANKY_BASE_URL=\"$clanky_base_url\";",
    "export CLANKY_API_KEY=\"$clanky_api_key\";",
    command,
  ].join(" ");
}

export function buildManagedContextStdinPayload(
  environment: Record<string, string | undefined> | undefined,
): string | undefined {
  const baseUrl = environment?.["CLANKY_BASE_URL"];
  const token = environment?.["CLANKY_API_KEY"];
  if (!baseUrl || !token) {
    return undefined;
  }

  return `${baseUrl}\n${token}\n`;
}
