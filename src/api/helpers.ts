/**
 * Shared API helper functions.
 *
 * This module provides common utilities used across API route handlers
 * to reduce code duplication and ensure consistent response formatting.
 *
 * @module api/helpers
 */

import type { ErrorResponse } from "../types/api";
import type { Workspace } from "../types/workspace";
import { getWorkspace } from "../persistence/workspaces";

/**
 * Create a standardized error response.
 *
 * @param error - Error code for programmatic handling
 * @param message - Human-readable error description
 * @param status - HTTP status code (default: 400)
 * @returns JSON Response with error details
 */
export function errorResponse(error: string, message: string, status = 400): Response {
  const body: ErrorResponse = { error, message };
  return Response.json(body, { status });
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
 *   const workspace = await getWorkspace(id);
 *   if (!workspace) { return Response.json({ message: "Workspace not found" }, { status: 404 }); }
 *
 * @param workspaceId - The workspace ID to look up
 * @returns Either the workspace object, or a 404 Response
 */
export async function requireWorkspace(
  workspaceId: string,
): Promise<Workspace | Response> {
  const workspace = await getWorkspace(workspaceId);
  if (!workspace) {
    return errorResponse("workspace_not_found", "Workspace not found", 404);
  }
  return workspace;
}
