/**
 * HTTP context and local preference policy around portable source federation.
 */

import { createLogger, type RouteDefinition, type RouteTable } from "@pablozaiden/webapp/server";
import { CreateChatRequestSchema } from "@/contracts/schemas";
import { encodeCollaborationResourceReference } from "@/shared/collaboration-reference";
import { CollaborationFederationClient, type CollaborationForwardContext } from "../client-sdk/collaboration/federation";
import { isReadRecord } from "@/shared/record";
import { DomainError } from "../domain/domain-error";
import { preferencesManager } from "../core/preferences-manager";
import { workspaceConnections } from "../core/workspace-connections";
import { projectCollaborationOperations } from "./collaboration-operation-metadata";
import { workspaceClientErrorResponse } from "./workspace-client-errors";
import { getWorkspaceAccessAuthority } from "../context/user-context";

const log = createLogger("api:workspace-federation");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

async function validateQuickChat(input: CollaborationForwardContext): Promise<Response | undefined> {
  if (input.path !== "/api/chats" || input.method !== "POST"
    || !isReadRecord(input.source.body) || input.source.body["quick"] !== true) return;
  const parsed = CreateChatRequestSchema.safeParse(input.source.body);
  if (!parsed.success) throw new DomainError("collaboration_request_invalid", "The quick-chat request is invalid.");
  try {
    await preferencesManager.validateQuickChatModel({
      workspaceId: encodeCollaborationResourceReference({
        connectionId: input.connectionId, resourceKind: "workspace", resourceId: parsed.data.workspaceId,
      }),
      model: parsed.data.model,
    });
  } catch (error) {
    return workspaceClientErrorResponse(error, "chats");
  }
}

export function withUnifiedWorkspaceResources(routes: RouteTable): RouteTable {
  const federation = new CollaborationFederationClient({
    operations: projectCollaborationOperations(routes), connections: workspaceConnections,
    logger: log, beforeForward: validateQuickChat,
  });
  return Object.fromEntries(Object.entries(routes).map(([path, route]) => {
    const next: RouteDefinition = { ...route };
    for (const method of METHODS) {
      const handler = route[method];
      if (!handler) continue;
      next[method] = async (request, ctx) => {
        if (ctx.delegation || getWorkspaceAccessAuthority()) return await handler(request, ctx);
        try {
          return await federation.request(request, async (localRequest: Request) => await handler(localRequest, ctx));
        } catch (error) {
          if (request.signal.aborted) {
            return workspaceClientErrorResponse(new DomainError("collaboration_request_aborted",
              "The workspace request was cancelled.", { cause: error }));
          }
          return workspaceClientErrorResponse(error);
        }
      };
    }
    return [path, next];
  }));
}
