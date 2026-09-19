/**
 * Shared API helper functions.
 *
 * This module provides common utilities used across API route handlers
 * to reduce code duplication and ensure consistent response formatting.
 *
 * @module api/helpers
 */

import type { ErrorResponse } from "@/contracts";
import type { Workspace } from "@/shared/workspace";
import { workspaceManager } from "../core/workspace-manager";
import { isDomainError } from "../core/domain-error";
import { assertGitBackedWorkspace } from "../core/workspace-capabilities";
import {
  getSafeDomainErrorMessage,
  getUnknownDomainErrorStatus,
  resolveDomainErrorHttpMapping,
  type DomainErrorHttpMapping,
  type DomainErrorPolicyName,
} from "./domain-error-policy";

/**
 * Create a standardized error response.
 *
 * @param error - Error code for programmatic handling
 * @param message - Human-readable error description
 * @param status - HTTP status code (default: 400)
 * @returns JSON Response with error details
 */
export function errorResponse(
  error: string,
  message: string,
  status = 400,
  extra: Record<string, unknown> = {},
): Response {
  const body: ErrorResponse = { error, message };
  return Response.json({ ...extra, ...body }, { status });
}

export interface DomainErrorResponseOptions {
  fallback: {
    error: string;
    message: string;
    status?: number;
  };
  policy?: DomainErrorPolicyName;
  mappings?: Readonly<Record<string, DomainErrorHttpMapping>>;
}

/**
 * Map a known typed domain failure at the HTTP boundary.
 *
 * Unknown failures intentionally use the caller's fixed fallback so internal
 * messages and implementation details are not exposed to clients.
 */
export function domainErrorResponse(
  error: unknown,
  options: DomainErrorResponseOptions,
): Response {
  const mapping = resolveDomainErrorHttpMapping(error, {
    fallback: options.fallback,
    mappings: options.mappings,
    policy: options.policy,
  });
  if (mapping) {
    const response = errorResponse(
      mapping.error ?? (isDomainError(error) ? error.code : options.fallback.error),
      mapping.message ?? getSafeDomainErrorMessage(
        isDomainError(error) ? error.code : "",
        options.fallback.message,
        options.policy,
      ),
      mapping.status,
      mapping.extra,
    );
    for (const [name, value] of Object.entries(mapping.headers ?? {})) {
      response.headers.set(name, value);
    }
    return response;
  }

  return errorResponse(
    options.fallback.error,
    options.fallback.message,
    getUnknownDomainErrorStatus(error, {
      fallbackStatus: options.fallback.status ?? 500,
      policy: options.policy,
    }),
  );
}

/**
 * Return a fixed, safe response for an unexpected API failure.
 *
 * The error is accepted so callers can preserve typed mappings when they have
 * them, but unknown failures never expose their internal message to clients.
 */
export function internalErrorResponse(
  error: unknown,
  fallback: { error: string; message: string; status?: number },
  mappings?: Readonly<Record<string, DomainErrorHttpMapping>>,
  policy?: DomainErrorPolicyName,
): Response {
  return domainErrorResponse(error, { fallback, mappings, policy });
}

/**
 * Create a standardized success response.
 *
 * @param data - Additional data to include in the response
 * @returns JSON Response with success: true and any additional data
 */
export function successResponse(data: Record<string, unknown> = {}): Response {
  return Response.json({ success: true, ...data });
}

/**
 * Look up a workspace by ID and return it, or return a 404 error response.
 *
 * This helper eliminates the repeated pattern of:
 *   const workspace = await workspaceManager.getWorkspace(id);
 *   if (!workspace) { return Response.json({ message: "Workspace not found" }, { status: 404 }); }
 *
 * @param workspaceId - The workspace ID to look up
 * @returns Either the workspace object, or a 404 Response
 */
export async function requireWorkspace(
  workspaceId: string,
): Promise<Workspace | Response> {
  const workspace = await workspaceManager.getWorkspace(workspaceId);
  if (!workspace) {
    return errorResponse("workspace_not_found", "Workspace not found", 404);
  }
  return workspace;
}

/**
 * Enforce Git-backed capabilities at API boundaries while keeping the
 * workspace lookup and public error mapping consistent.
 */
export function requireGitBackedWorkspace(
  workspace: Workspace,
): Workspace | Response {
  try {
    assertGitBackedWorkspace(workspace);
    return workspace;
  } catch (error) {
    return domainErrorResponse(error, {
      policy: "workspaces",
      fallback: {
        error: "workspace_capability_failed",
        message: "Workspace capability validation failed",
        status: 500,
      },
    });
  }
}
