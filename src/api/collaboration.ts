/**
 * Per-user pairing controls; a shared-workspace guest cannot delegate these.
 */
import { defineRoutes } from "@pablozaiden/webapp/server";
import { CreateCollaborationInvitationSchema } from "@/contracts/schemas/collaboration";
import { ConnectWorkspaceControllerSchema } from "@/contracts/schemas/mesh-client";
import {
  MESH_RELAY_CLIENT_ENROLLMENT_PATH,
  MESH_RELAY_CLIENT_OPERATION_PATH,
} from "@/shared/mesh-relay";
import { collaborationService } from "../core/collaboration-service";
import { workspaceClientController } from "../core/workspace-client-controller";
import { workspaceConnections } from "../core/workspace-connections";
import { createWorkspaceInvitation } from "../core/workspace-invitation-service";
import { controllerRelayService } from "../core/controller-relay-service";
import { parseAndValidate } from "./validation";
import { successResponse } from "./helpers";
import { workspaceClientErrorResponse } from "./workspace-client-errors";
import { dispatchWorkspaceClient, enrollWorkspaceClient } from "./workspace-client-gateway";

export const collaborationRoutes = defineRoutes({
  "/api/collaboration/relays": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List paired relay choices for sharing this user's workspaces.",
    operations: { GET: { automation: { policy: "read" } } },
    async GET() {
      const status = await controllerRelayService.getStatus();
      return Response.json(status.relays.map(({ name, connected }) => ({ name, connected })));
    },
  },
  "/api/collaboration/invitations": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List invitations or invite one client to selected owned workspaces through a paired relay.",
    operations: {
      GET: { automation: { policy: "read" } },
      POST: {
        requestSchema: CreateCollaborationInvitationSchema,
        automation: { policy: "confirm", reason: "Grants a collaborator access to selected workspace contents and execution capabilities." },
      },
    },
    GET() {
      return Response.json(collaborationService.listInvitations());
    },
    async POST(req, ctx) {
      const parsed = await parseAndValidate(CreateCollaborationInvitationSchema, req);
      if (!parsed.success) return parsed.response;
      try {
        const result = await createWorkspaceInvitation(parsed.data);
        ctx.userRealtime.publishChanged("workspace-collaboration");
        return Response.json(result, { status: 201 });
      } catch (error) {
        return workspaceClientErrorResponse(error);
      }
    },
  },
  "/api/collaboration/invitations/:id": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Revoke an unused workspace invitation.",
    operations: { DELETE: { automation: { policy: "write" } } },
    DELETE(_req, ctx) {
      try {
        collaborationService.revokeInvitation(ctx.params["id"]!);
        ctx.userRealtime.publishChanged("workspace-collaboration");
        return successResponse();
      } catch (error) {
        return workspaceClientErrorResponse(error);
      }
    },
  },
  "/api/collaboration/guests": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List collaborators and their current workspace grants.",
    operations: { GET: { automation: { policy: "read" } } },
    GET() {
      return Response.json(collaborationService.listGuests());
    },
  },
  "/api/collaboration/guests/:id": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Revoke a collaborator; admitted tasks, chats and schedules continue.",
    operations: { DELETE: { automation: { policy: "confirm", reason: "Closes this collaborator's terminals and previews and revokes workspace access." } } },
    async DELETE(_req, ctx) {
      try {
        await workspaceClientController.revoke(ctx.params["id"]!);
        return successResponse();
      } catch (error) {
        return workspaceClientErrorResponse(error);
      }
    },
  },
  "/api/collaboration/guests/:id/workspaces/:workspaceId": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Revoke one workspace without affecting the collaborator's remaining grants.",
    operations: { DELETE: { automation: { policy: "confirm", reason: "Closes the collaborator's terminals and previews in this workspace." } } },
    async DELETE(_req, ctx) {
      try {
        await workspaceClientController.revoke(ctx.params["id"]!, ctx.params["workspaceId"]!);
        return successResponse();
      } catch (error) {
        return workspaceClientErrorResponse(error);
      }
    },
  },
  "/api/collaboration/connections": {
    auth: "user",
    sameOrigin: "mutations",
    description: "List controller connection health or accept a signed workspace invitation.",
    operations: {
      GET: { automation: { policy: "read" } },
      POST: { requestSchema: ConnectWorkspaceControllerSchema, automation: { policy: "confirm", reason: "Pairs this user with the invitation's pinned controller and relay." } },
    },
    GET() {
      return Response.json(workspaceConnections.list());
    },
    async POST(req) {
      const parsed = await parseAndValidate(ConnectWorkspaceControllerSchema, req);
      if (!parsed.success) return parsed.response;
      try {
        return Response.json(await workspaceConnections.accept(parsed.data), { status: 201 });
      } catch (error) {
        return workspaceClientErrorResponse(error);
      }
    },
  },
  "/api/collaboration/connections/:id": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Disconnect this user's local pairing without cancelling controller work.",
    operations: { DELETE: { automation: { policy: "write" } } },
    async DELETE(_req, ctx) {
      try {
        await workspaceConnections.disconnect(ctx.params["id"]!);
        return successResponse();
      } catch (error) {
        return workspaceClientErrorResponse(error);
      }
    },
  },
  "/api/collaboration/connections/:id/recover": {
    auth: "user",
    sameOrigin: "mutations",
    description: "Recover a pending pairing with its existing key; never repeats workspace mutations.",
    operations: { POST: { automation: { policy: "write" } } },
    async POST(_req, ctx) {
      try {
        return Response.json(await workspaceConnections.recover(ctx.params["id"]!));
      } catch (error) {
        return workspaceClientErrorResponse(error);
      }
    },
  },
});

// Public framework auth is intentional: signed Mesh possession and grant checks
// authenticate peers instead of browser cookies or an owner's bearer key.
export const workspaceClientInternalRoutes = defineRoutes({
  [MESH_RELAY_CLIENT_ENROLLMENT_PATH]: {
    auth: "public",
    sameOrigin: "never",
    catalog: false,
    POST: enrollWorkspaceClient,
  },
  [MESH_RELAY_CLIENT_OPERATION_PATH]: {
    auth: "public",
    sameOrigin: "never",
    catalog: false,
    POST: dispatchWorkspaceClient,
  },
});
