/**
 * API request validation utilities using Zod.
 *
 * This module provides helpers for validating API request bodies against
 * Zod schemas, with consistent error formatting that matches the existing
 * ErrorResponse format.
 *
 * @module api/validation
 */

import { z, ZodError } from "zod";
import type { ErrorResponse } from "@/contracts";

/**
 * Result of a validation operation.
 * Either success with parsed data, or failure with a Response to return.
 */
export type ValidationResult<T> =
  | { success: true; data: T }
  | { success: false; response: Response };

export interface ParseAndValidateOptions {
  allowEmptyBody?: boolean;
  emptyBodyValue?: unknown;
  maxBodyBytes?: number;
}

/**
 * Validate a request body against a Zod schema.
 *
 * @param schema - The Zod schema to validate against
 * @param body - The request body to validate (usually from req.json())
 * @returns ValidationResult with either parsed data or error response
 *
 * @example
 * ```typescript
 * const result = validateRequest(CreateTaskRequestSchema, await req.json());
 * if (!result.success) {
 *   return result.response;
 * }
 * const data = result.data; // Typed as CreateTaskRequest
 * ```
 */
export function validateRequest<T>(
  schema: z.ZodType<T>,
  body: unknown
): ValidationResult<T> {
  const result = schema.safeParse(body);
  if (!result.success) {
    return { success: false, response: validationErrorResponse(result.error) };
  }
  return { success: true, data: result.data };
}

/**
 * Format a Zod error into a human-readable message.
 * Combines multiple errors into a single message.
 */
function formatZodError(error: ZodError): string {
  const issues = error.issues;

  if (issues.length === 1 && issues[0]) {
    const issue = issues[0];
    const path = issue.path.join(".");
    if (path) {
      return `${path}: ${issue.message}`;
    }
    return issue.message;
  }

  // Multiple errors - combine them
  return issues
    .map((issue) => {
      const path = issue.path.join(".");
      if (path) {
        return `${path}: ${issue.message}`;
      }
      return issue.message;
    })
    .join("; ");
}

/**
 * Create a 400 validation error response in the standard ErrorResponse format.
 */
function validationErrorResponse(error: ZodError): Response {
  const body: ErrorResponse = {
    error: "validation_error",
    message: formatZodError(error),
  };
  return Response.json(body, { status: 400 });
}

function invalidJsonResponse(): Response {
  const body: ErrorResponse = {
    error: "invalid_json",
    message: "Request body must be valid JSON",
  };
  return Response.json(body, { status: 400 });
}

function requestBodyTooLargeResponse(): Response {
  const body: ErrorResponse = {
    error: "request_body_too_large",
    message: "Request body exceeds the supported size limit.",
  };
  return Response.json(body, { status: 413 });
}

async function readRequestBody(req: Request, maxBodyBytes?: number): Promise<string | Response> {
  if (maxBodyBytes === undefined) return await req.text();
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 0) {
    throw new Error("maxBodyBytes must be a non-negative safe integer.");
  }
  const contentLength = req.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isSafeInteger(declaredBytes) && declaredBytes > maxBodyBytes) {
      return requestBodyTooLargeResponse();
    }
  }

  const reader = req.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBodyBytes) {
        await reader.cancel();
        return requestBodyTooLargeResponse();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Parse request body as JSON and validate against a schema.
 * Combines JSON parsing and validation into a single operation.
 *
 * @param schema - The Zod schema to validate against
 * @param req - The Request object to parse body from
 * @returns ValidationResult with either parsed data or error response
 *
 * @example
 * ```typescript
 * const result = await parseAndValidate(CreateTaskRequestSchema, req);
 * if (!result.success) {
 *   return result.response;
 * }
 * const data = result.data; // Typed as CreateTaskRequest
 * ```
 */
export async function parseAndValidate<T>(
  schema: z.ZodType<T>,
  req: Request,
  options?: ParseAndValidateOptions,
): Promise<ValidationResult<T>> {
  let rawBody: string;
  try {
    const read = await readRequestBody(req, options?.maxBodyBytes);
    if (read instanceof Response) return { success: false, response: read };
    rawBody = read;
  } catch {
    return { success: false, response: invalidJsonResponse() };
  }

  if (rawBody.trim() === "") {
    if (!options?.allowEmptyBody) {
      return { success: false, response: invalidJsonResponse() };
    }
    return validateRequest(schema, options.emptyBodyValue ?? {});
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { success: false, response: invalidJsonResponse() };
  }

  return validateRequest(schema, body);
}
