/**
 * Canonical route-to-data projection; never imports a generated client catalog.
 */

import { z } from "zod";
import { HTTP_METHODS, type HttpMethod } from "@pablozaiden/webapp/routing";
import { resolveRouteOperationMetadata, type RouteDefinition, type RouteTable } from "@pablozaiden/webapp/server";
import type { CollaborationOperationMetadata, CollaborationRouteOperation } from "@/shared/collaboration-operation";

export function collaborationOperationMetadata(
  path: string,
  method: HttpMethod,
  route: RouteDefinition,
): CollaborationOperationMetadata {
  const metadata = resolveRouteOperationMetadata(route, method);
  const automation = route.operations?.[method]?.automation;
  const result: CollaborationOperationMetadata = { delegation: metadata.delegation || false };
  if (!automation || automation.policy === "excluded") return result;
  const query = metadata.querySchema;
  if (query !== undefined && !(query instanceof z.ZodObject)) {
    throw new Error(`Resource read options require an object query contract: ${method} ${path}`);
  }
  const nativeRead = query instanceof z.ZodObject && Object.hasOwn(query.shape, "view");
  result.read = {
    readOnly: method === "GET" || automation.policy === "read",
    nativeRead,
    conversation: nativeRead && query.shape["view"]?.safeParse("conversation").success === true,
    nativeQueryFields: query instanceof z.ZodObject ? Object.keys(query.shape) : [],
    hiddenInputs: automation.hiddenInputs ?? [],
  };
  return result;
}

export function projectCollaborationOperations(routes: RouteTable): CollaborationRouteOperation[] {
  return Object.entries(routes).flatMap(([path, route]) => HTTP_METHODS
    .filter((method) => typeof route[method] === "function")
    .map((method) => ({ path, method, metadata: collaborationOperationMetadata(path, method, route) })));
}
