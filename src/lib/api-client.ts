/**
 * Browser-safe typed request helpers for Clanky's HTTP API.
 */

import { createLogger } from "@pablozaiden/webapp/web";
import { parseApiError } from "./api-error";
import { appFetch } from "./public-path";

export type ApiResponseMode = "json" | "text" | "blob" | "empty";

export interface ApiRequestOptions extends RequestInit {
  action?: string;
  fallbackMessage?: string;
  acceptedStatuses?: readonly number[];
}

export type TypedApiRequestOptions = ApiRequestOptions & {
  responseType?: ApiResponseMode;
};

const log = createLogger("apiClient");

function getActionName(path: string, action?: string): string {
  const trimmedAction = action?.trim();
  return trimmedAction || `Request ${path}`;
}

function getFallbackMessage(action: string, fallbackMessage?: string): string {
  return fallbackMessage?.trim() || `Failed to ${action.toLowerCase()}`;
}

function isAcceptedStatus(response: Response, acceptedStatuses?: readonly number[]): boolean {
  return response.ok || acceptedStatuses?.includes(response.status) === true;
}

function getMethod(init: RequestInit): string {
  return (init.method ?? "GET").toUpperCase();
}

/**
 * Execute a request and validate its status without consuming the response body.
 *
 * This is intentionally the escape hatch for ETag/304 handling and streaming
 * callers that need to inspect or consume the raw response themselves.
 */
export async function requestApiResponse(
  path: string,
  options: ApiRequestOptions = {},
): Promise<Response> {
  const {
    action: actionOption,
    fallbackMessage,
    acceptedStatuses,
    ...init
  } = options;
  const action = getActionName(path, actionOption);
  const method = getMethod(init);

  log.debug("API request started", { action, method, url: path });

  let response: Response;
  try {
    response = await appFetch(path, init);
  } catch (error) {
    log.error("API request failed before receiving a response", {
      action,
      method,
      url: path,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  if (!isAcceptedStatus(response, acceptedStatuses)) {
    const apiError = await parseApiError(response, getFallbackMessage(action, fallbackMessage));
    const metadata = {
      action,
      method,
      url: path,
      status: apiError.status,
      errorCode: apiError.code,
    };
    if (apiError.status >= 500) {
      log.error("API request failed", metadata);
    } else {
      log.warn("API request rejected", metadata);
    }
    throw apiError;
  }

  log.debug("API request succeeded", {
    action,
    method,
    url: path,
    status: response.status,
  });
  return response;
}

export function readApiResponse<T>(
  response: Response,
  responseType?: "json",
): Promise<T>;

export function readApiResponse(
  response: Response,
  responseType: "text",
): Promise<string>;

export function readApiResponse(
  response: Response,
  responseType: "blob",
): Promise<Blob>;

export function readApiResponse(
  response: Response,
  responseType: "empty",
): Promise<void>;

export function readApiResponse<T>(
  response: Response,
  responseType: ApiResponseMode,
): Promise<T | string | Blob | void>;

export async function readApiResponse<T>(
  response: Response,
  responseType: ApiResponseMode = "json",
): Promise<T | string | Blob | void> {
  switch (responseType) {
    case "text":
      return await response.text();
    case "blob":
      return await response.blob();
    case "empty":
      return;
    case "json":
      return await response.json() as T;
  }
}

export function apiRequest<T>(
  path: string,
  options?: TypedApiRequestOptions & { responseType?: "json" },
): Promise<T>;

export function apiRequest(
  path: string,
  options: TypedApiRequestOptions & { responseType: "text" },
): Promise<string>;

export function apiRequest(
  path: string,
  options: TypedApiRequestOptions & { responseType: "blob" },
): Promise<Blob>;

export function apiRequest(
  path: string,
  options: TypedApiRequestOptions & { responseType: "empty" },
): Promise<void>;

export async function apiRequest<T>(
  path: string,
  options: TypedApiRequestOptions = {},
): Promise<T | string | Blob | void> {
  const {
    responseType = "json",
    ...requestOptions
  } = options;
  const response = await requestApiResponse(path, requestOptions);
  return await readApiResponse(response, responseType);
}
