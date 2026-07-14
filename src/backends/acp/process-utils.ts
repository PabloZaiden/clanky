/**
 * Process spawn utilities for the ACP backend.
 */

import { SSHPASS_INVALID_PASSWORD_EXIT_CODE } from "./types";
import { isAcpErrorCode } from "./errors";

/**
 * Sanitize process args before logging.
 * Masks sshpass password values while keeping other args visible.
 */
export function sanitizeSpawnArgsForLogging(command: string, args: string[]): string[] {
  if (command !== "sshpass") {
    return args;
  }

  const sanitizedArgs = [...args];
  for (let i = 0; i < sanitizedArgs.length - 1; i++) {
    if (sanitizedArgs[i] === "-p") {
      sanitizedArgs[i + 1] = "***";
      break;
    }
  }

  return sanitizedArgs;
}

export function getProcessExitHint(command: string, exitCode: number): string | undefined {
  if (command === "sshpass" && exitCode === SSHPASS_INVALID_PASSWORD_EXIT_CODE) {
    return "sshpass reported authentication failure (invalid username/password or auth method mismatch).";
  }
  return undefined;
}

export function isTransientSshAuthenticationFailure(error: unknown): boolean {
  return isAcpErrorCode(error, "acp_ssh_authentication_failed");
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
  return "copilot";
}
