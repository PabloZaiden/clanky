/**
 * Internal API call helpers shared across task-action modules.
 * Not re-exported from the barrel.
 */

import { createLogger } from "../../lib/logger";
import { ApiError, parseApiError } from "../../lib/api-error";
import { appFetch } from "../../lib/public-path";

export const log = createLogger("taskActions");

/**
 * Generic API call helper that eliminates boilerplate across task action functions.
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
    const apiError = await parseApiError(response, `Failed to ${actionName.toLowerCase()}`);
    const errorMessage = extractError
      ? extractError({
          code: apiError.code,
          error: apiError.code,
          message: apiError.message,
        }) ?? apiError.message
      : apiError.message;
    log.error(`API: ${actionName} failed`, { url, error: errorMessage });
    if (errorMessage !== apiError.message) {
      throw new ApiError(errorMessage, {
        code: apiError.code,
        status: apiError.status,
        cause: apiError,
      });
    }
    throw apiError;
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
