/**
 * Server-only delegated application dispatch over authenticated Mesh streams.
 */
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import type { CollaborationGuestGrant } from "@/shared/collaboration";
import type { WebAppServer } from "@pablozaiden/webapp/server";
import { WorkspaceClientEnrollmentSchema } from "@/contracts/schemas/mesh-client";
import { ChatTrashPageSchema, ChatTrashQuerySchema, type ChatTrashPage } from "@/contracts/schemas/chat-trash";
import { mergeChatTrashPages } from "../core/chat-trash-pagination";
import { MESH_RELAY_CLIENT_ENROLLMENT_PATH } from "@/shared/mesh-relay";
import type { ClankyRealtimeEvent } from "../realtime";
import { runWithCollaborationActor, runWithCurrentUser } from "../context/user-context";
import { DomainError } from "../domain/domain-error";
import { collaborationService } from "../core/collaboration-service";
import { workspaceClientController } from "../core/workspace-client-controller";
import { getMeshRelayRequestInitiatorNodeId } from "../core/mesh-relay-http";
import { isSecureMeshRequest } from "../core/mesh-transport-security";
import { readWorkspaceClientProof } from "../core/workspace-client-proof";
import { authorizeWorkspaceOperation, resolveOperationWorkspaces } from "../core/workspace-operation-authority";
import { reconstructWorkspaceRequest, readWorkspaceRequestBytes, verifyWorkspaceBody } from "./workspace-client-request";
import { workspaceClientErrorResponse } from "./workspace-client-errors";

let application: WebAppServer<ClankyRealtimeEvent> | undefined;

export function configureWorkspaceClientGateway(app: WebAppServer<ClankyRealtimeEvent>): void {
  application = app;
}

export function workspaceGuestActor(guest: CollaborationGuestGrant): CurrentUser {
  return {
    id: `workspace-guest:${guest.id}`, username: guest.name ?? "Collaborator",
    role: "user", isOwner: false, isAdmin: false,
  };
}

export async function enrollWorkspaceClient(request: Request): Promise<Response> {
  try {
    const unverified = readWorkspaceClientProof(request.headers);
    const bytes = await readWorkspaceRequestBytes(request, 64 * 1_024);
    let raw: unknown;
    try {
      raw = JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      throw new DomainError("collaboration_request_invalid", "The enrollment body is invalid.", { cause: error });
    }
    const parsed = WorkspaceClientEnrollmentSchema.safeParse(raw);
    if (!parsed.success) {
      throw new DomainError("collaboration_request_invalid", "The enrollment fields are invalid.", { cause: parsed.error });
    }
    const input = parsed.data;
    const metadata = await workspaceClientController.verifyProof({
      headers: request.headers,
      publicKey: input.guest.publicKey,
      initiatorNodeId: getMeshRelayRequestInitiatorNodeId(request),
      secureTransport: isSecureMeshRequest(request),
    });
    if (metadata.kind !== "enrollment" || metadata.method !== "POST"
      || metadata.path !== MESH_RELAY_CLIENT_ENROLLMENT_PATH
      || unverified.nodeId !== input.guest.nodeId) {
      throw new DomainError("collaboration_request_invalid", "The enrollment proof does not match its operation.");
    }
    await verifyWorkspaceBody(new Request(request.url, { method: "POST", body: bytes }), metadata, 64 * 1_024);
    return Response.json(await workspaceClientController.enroll(input));
  } catch (error) {
    return workspaceClientErrorResponse(error);
  }
}

export async function dispatchWorkspaceClient(request: Request): Promise<Response> {
  try {
    if (!application) throw new Error("The application dispatcher is unavailable.");
    const nodeId = getMeshRelayRequestInitiatorNodeId(request);
    const guest = nodeId ? collaborationService.getAuthenticatedGuest(nodeId) : undefined;
    if (!guest) throw new DomainError("collaboration_access_denied", "The client grant is unavailable.");
    const metadata = await workspaceClientController.verifyProof({
      headers: request.headers, initiatorNodeId: nodeId,
      publicKey: guest.identity.publicKey, secureTransport: isSecureMeshRequest(request),
    });
    if (metadata.kind !== "operation") {
      throw new DomainError("collaboration_request_invalid", "An application operation proof is required.");
    }
    const inner = await reconstructWorkspaceRequest(request, metadata);
    const actor = workspaceGuestActor(guest);
    const response = await runWithCurrentUser(actor, async () => await runWithCollaborationActor(
      { kind: "guest", guestId: guest.id, nodeId: guest.identity.nodeId },
      async () => await application!.dispatchDelegated(inner, {
        actor,
        onError: (error) => workspaceClientErrorResponse(error),
        authorize: async (operation, delegatedRequest) => ({
          workspaceIds: await resolveOperationWorkspaces({
            guest, operation, request: delegatedRequest, workspaceId: metadata.workspaceId,
          }),
          operation,
        }),
        run: async (invocation, invoke) => {
          const results: unknown[] = [];
          const trash: ChatTrashPage[] = [];
          const pagedTrash = invocation.operation.delegation.action === "trash-list";
          for (const workspaceId of invocation.authorization.workspaceIds) {
            const result = await collaborationService.withWorkspaceAccess(workspaceId, async () => {
              await authorizeWorkspaceOperation({
                guest, workspaceId, operation: invocation.authorization.operation, request: inner,
              });
              return await invoke();
            });
            if (!invocation.operation.delegation.collection || inner.method !== "GET"
              || invocation.authorization.workspaceIds.length === 1) return result;
            if (!result?.ok) return result;
            const value: unknown = await result.json();
            if (pagedTrash) {
              const page = ChatTrashPageSchema.safeParse(value);
              if (!page.success) throw new DomainError("collaboration_response_invalid", "The delegated Trash page is invalid.");
              trash.push(page.data);
              continue;
            }
            if (!Array.isArray(value)) {
              throw new DomainError("collaboration_response_invalid", "The delegated collection has an invalid response.");
            }
            results.push(...value);
          }
          return Response.json(pagedTrash
            ? mergeChatTrashPages(trash, ChatTrashQuerySchema.parse(Object.fromEntries(new URL(inner.url).searchParams)).limit)
            : results);
        },
      }),
    ));
    return response ?? new Response(null, { status: 404 });
  } catch (error) {
    return workspaceClientErrorResponse(error);
  }
}
