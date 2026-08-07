/**
 * Internal API call helpers shared across task-action modules.
 * Not re-exported from the barrel.
 */

import { ApiError } from "../../lib/api-error";
import { apiRequest } from "../../lib/api-client";

/**
 * Task-specific action wrappers around the shared typed API client.
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
  try {
    return await apiRequest<T>(url, {
      ...options,
      action: actionName,
      fallbackMessage: `Failed to ${actionName.toLowerCase()}`,
    });
  } catch (error) {
    if (extractError && error instanceof ApiError) {
      const errorMessage = extractError({
        ...error.data,
        code: error.code,
        error: error.code,
        message: error.message,
      }) ?? error.message;
      if (errorMessage !== error.message) {
        throw new ApiError(errorMessage, {
          code: error.code,
          status: error.status,
          cause: error,
          data: error.data,
        });
      }
    }
    throw error;
  }
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
