/**
 * Process spawn utilities for the ACP backend.
 */

import { DEFAULT_EXECUTION_AGENT_PROVIDER } from "@/shared/settings";

/**
 * Sanitize process args before logging.
 */
export function sanitizeSpawnArgsForLogging(args: string[]): string[] {
  const sanitizedArgs = [...args];

  if (sanitizedArgs.some((arg) => arg.includes("CLANKY_API_KEY="))) {
    return ["[managed runtime command redacted]"];
  }

  return sanitizedArgs;
}

export function inferProviderID(modelID: string): string {
  const providerPrefix = modelID.split("/", 1)[0];
  if (providerPrefix && providerPrefix !== modelID) {
    return providerPrefix;
  }
  if (modelID.startsWith("claude")) {
    return "anthropic";
  }
  if (modelID.startsWith("gpt")) {
    return "openai";
  }
  if (modelID.startsWith("gemini")) {
    return "google";
  }
  return DEFAULT_EXECUTION_AGENT_PROVIDER;
}
