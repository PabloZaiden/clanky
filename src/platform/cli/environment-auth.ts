import { assertEnvPrefix } from "../server/runtime-config";
import { normalizeBaseUrl } from "./device-auth";

export interface CliAuthEnvironmentNames {
  baseUrl: string;
  apiKey: string;
}

export interface EnvironmentApiKeyAuth {
  baseUrl: string;
  apiKey: string;
  source: "explicit-base-url" | "environment";
}

export type CliEnvironment = Readonly<Record<string, string | undefined>>;

function nonEmptyEnvValue(environment: CliEnvironment, name: string): string | undefined {
  const value = environment[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function cliAuthEnvironmentNames(envPrefix: string): CliAuthEnvironmentNames {
  const prefix = assertEnvPrefix(envPrefix);
  return {
    baseUrl: `${prefix}_BASE_URL`,
    apiKey: `${prefix}_API_KEY`,
  };
}

export function resolveEnvironmentApiKeyAuth(input: {
  envPrefix: string;
  explicitBaseUrl?: string;
  environment?: CliEnvironment;
}): EnvironmentApiKeyAuth | undefined {
  const names = cliAuthEnvironmentNames(input.envPrefix);
  const environment = input.environment ?? process.env;
  const apiKey = nonEmptyEnvValue(environment, names.apiKey);
  if (!apiKey) return undefined;

  if (input.explicitBaseUrl !== undefined) {
    return {
      baseUrl: normalizeBaseUrl(input.explicitBaseUrl),
      apiKey,
      source: "explicit-base-url",
    };
  }

  const baseUrl = nonEmptyEnvValue(environment, names.baseUrl);
  if (!baseUrl) return undefined;
  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    apiKey,
    source: "environment",
  };
}
