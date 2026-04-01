/**
 * Internal API call helpers shared across loop-action modules.
 * Not re-exported from the barrel.
 */

import { createLogger } from "../../lib/logger";
import { appFetch } from "../../lib/public-path";

export const log = createLogger("loopActions");

/**
 * Generic API call helper that eliminates boilerplate across loop action functions.
 *
 * Handles: fetch, error checking, JSON parsing, logging, and error throwing.
 *
 * @param url - API endpoint URL
 * @param options - Fetch options (method, body, etc.)
 * @param actionName - Human-readable action name for logging and error messages
 * @param extractError - Optional custom error extractor from error response data
 * @returns Parsed JSON response data
 */
export async function apiCall<T = unknown>(
  url: string,
  options: RequestInit,
  actionName: string,
  extractError?: (data: Record<string, unknown>) => string | undefined,
): Promise<T> {
  log.debug(`API: ${actionName}`, { url });
  const response = await appFetch(url, options);

  if (!response.ok) {
    let errorData: Record<string, unknown> = {};
    try {
      const text = await response.text();
      if (text) {
        try {
          errorData = JSON.parse(text) as Record<string, unknown>;
        } catch {
          errorData = { message: text };
        }
      }
    } catch {
      // ignore body reading errors; fall back to generic message below
    }
    const errorMessage = extractError
      ? extractError(errorData)
      : errorData["message"] as string | undefined;
    const finalMessage = errorMessage || `Failed to ${actionName.toLowerCase()}`;
    log.error(`API: ${actionName} failed`, { url, error: finalMessage });
    throw new Error(finalMessage);
  }

  const data = await response.json() as T;
  log.debug(`API: ${actionName} success`, { url });
  return data;
}

/**
 * Shortcut for a simple API call that returns true on success.
 * Used for actions that don't need response body data.
 */
export async function apiAction(
  url: string,
  method: string,
  actionName: string,
): Promise<boolean> {
  await apiCall(url, { method }, actionName);
  return true;
}

/**
 * Shortcut for an API call with a JSON body that returns true on success.
 */
export async function apiActionWithBody(
  url: string,
  method: string,
  body: unknown,
  actionName: string,
): Promise<boolean> {
  await apiCall(
    url,
    {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    actionName,
  );
  return true;
}
