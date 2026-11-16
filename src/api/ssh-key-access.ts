import { z } from "zod";
import { defineRoutes } from "@/platform/server";
import { RegisterSshKeySourceSchema, RegisterSshPublicKeySchema, SetWorkspaceSshKeyGrantSchema } from "@/contracts/schemas/ssh-key-access";
import { sshKeyAccessService, revokeProvisioningSshKeyLease } from "../core/ssh-key-access-service";
import { isDomainError } from "../domain/domain-error";
import { errorResponse } from "./helpers";
import { parseAndValidate } from "./validation";
import { executionHostRefFromParts } from "@/shared/execution-host";
import { sshAgentError } from "../core/ssh-agent-protocol";

export function sshKeyAccessErrorResponse(error: unknown): Response {
  if (isDomainError(error) && error.code.startsWith("ssh_agent_")) {
    const status = error.code === "ssh_agent_access_denied" || error.code === "ssh_agent_context_invalid" || error.code === "ssh_agent_operation_forbidden" ? 403
      : error.code === "ssh_agent_protocol_invalid" || error.code === "ssh_agent_lease_invalid" ? 400
      : error.code === "ssh_agent_key_revoked" ? 409 : 503;
    return errorResponse(error.code, error.message, status);
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) return errorResponse("ssh_agent_protocol_invalid", "The SSH-agent request or response is invalid.", 400);
  return errorResponse("ssh_agent_unavailable", "Scoped SSH-agent access is unavailable.", 503);
}
const read = { requestSchema: undefined, querySchema: undefined, automation: { policy: "read" as const } };
const change = { policy: "confirm" as const, reason: "Changes access to owner-selected SSH-agent keys." };
function hostFromParams(params: Record<string, string>) {
  const host = executionHostRefFromParts(params["kind"]!, params["id"]!);
  if (!host) throw sshAgentError("protocol_invalid", "The execution host must be local or Mesh.");
  return host;
}
export const sshKeyAccessRoutes = defineRoutes({
  "/api/ssh-key-access": {
    auth: "user", sameOrigin: "mutations",
    description: "List this account's registered SSH-agent sources and public keys.",
    tags: ["ssh-key-access"], operations: { GET: read },
    GET(_req, ctx) {
      try { return Response.json(sshKeyAccessService.list(ctx.requireUser().id)); }
      catch (error) { return sshKeyAccessErrorResponse(error); }
    },
  },
  "/api/ssh-key-access/sources": {
    auth: "user", sameOrigin: "mutations",
    description: "Authorize a local or enrolled Mesh host as an SSH-agent public-key source.",
    tags: ["ssh-key-access"], requestSchema: RegisterSshKeySourceSchema,
    operations: { POST: { requestSchema: RegisterSshKeySourceSchema, querySchema: undefined, automation: change } },
    async POST(req, ctx) {
      const parsed = await parseAndValidate(RegisterSshKeySourceSchema, req);
      if (!parsed.success) return parsed.response;
      try {
        const source = await sshKeyAccessService.registerSource(ctx.requireUser().id, parsed.data);
        ctx.userRealtime.publishChanged("ssh-key-access");
        return Response.json(source, { status: 201 });
      }
      catch (error) { return sshKeyAccessErrorResponse(error); }
    },
  },
  "/api/ssh-key-access/sources/:sourceId": {
    auth: "user", sameOrigin: "mutations",
    description: "Remove an SSH-agent source and all of its public-key grants.",
    tags: ["ssh-key-access"], operations: { DELETE: { requestSchema: undefined, querySchema: undefined, automation: change } },
    DELETE(_req, ctx) {
      try {
        sshKeyAccessService.removeSource(ctx.requireUser().id, ctx.params["sourceId"]!);
        ctx.userRealtime.publishChanged("ssh-key-access");
        return Response.json({ success: true });
      }
      catch (error) { return sshKeyAccessErrorResponse(error); }
    },
  },
  "/api/ssh-key-access/sources/:sourceId/identities": {
    auth: "user", sameOrigin: "mutations",
    description: "Discover public identities currently loaded in the selected authorized SSH agent.",
    tags: ["ssh-key-access"], operations: { GET: read },
    async GET(_req, ctx) {
      try { return Response.json({ identities: await sshKeyAccessService.discover(ctx.requireUser().id, ctx.params["sourceId"]!) }); }
      catch (error) { return sshKeyAccessErrorResponse(error); }
    },
  },
  "/api/ssh-key-access/sources/:sourceId/keys": {
    auth: "user", sameOrigin: "mutations",
    description: "Register an alias for a public identity already loaded in the selected source agent.",
    tags: ["ssh-key-access"], requestSchema: RegisterSshPublicKeySchema,
    operations: { POST: { requestSchema: RegisterSshPublicKeySchema, querySchema: undefined, automation: change } },
    async POST(req, ctx) {
      const parsed = await parseAndValidate(RegisterSshPublicKeySchema, req);
      if (!parsed.success) return parsed.response;
      try {
        const key = await sshKeyAccessService.registerKey(ctx.requireUser().id, ctx.params["sourceId"]!, parsed.data);
        ctx.userRealtime.publishChanged("ssh-key-access");
        return Response.json(key, { status: 201 });
      }
      catch (error) { return sshKeyAccessErrorResponse(error); }
    },
  },
  "/api/workspaces/:workspaceId/ssh-key-access": {
    auth: "user", sameOrigin: "mutations",
    description: "List public SSH-agent keys and their current grants for an owned workspace.",
    tags: ["ssh-key-access"], operations: { GET: read },
    async GET(_req, ctx) {
      try { return Response.json(await sshKeyAccessService.workspaceAccess(ctx.requireUser().id, ctx.params["workspaceId"]!)); }
      catch (error) { return sshKeyAccessErrorResponse(error); }
    },
  },
  "/api/workspaces/:workspaceId/ssh-key-access/:keyId": {
    auth: "user", sameOrigin: "mutations",
    description: "Enable or revoke a workspace's use of one SSH-agent key. Revocation blocks new signatures, not established SSH sessions.",
    tags: ["ssh-key-access"], requestSchema: SetWorkspaceSshKeyGrantSchema,
    operations: { PUT: { requestSchema: SetWorkspaceSshKeyGrantSchema, querySchema: undefined, automation: change } },
    async PUT(req, ctx) {
      const parsed = await parseAndValidate(SetWorkspaceSshKeyGrantSchema, req);
      if (!parsed.success) return parsed.response;
      try {
        const result = await sshKeyAccessService.setGrant(ctx.requireUser().id, ctx.params["workspaceId"]!, ctx.params["keyId"]!, parsed.data.enabled);
        ctx.userRealtime.publishChanged("ssh-key-access");
        return Response.json(result);
      } catch (error) { return sshKeyAccessErrorResponse(error); }
    },
  },
  "/api/workspaces/:workspaceId/ssh-agent": {
    auth: "user", sameOrigin: "mutations",
    description: "Open a private filtered SSH-agent socket on the workspace's verified execution host.",
    tags: ["ssh-key-access"], operations: { POST: { requestSchema: undefined, querySchema: undefined, automation: change } },
    async POST(_req, ctx) {
      try { return Response.json(await sshKeyAccessService.ensureWorkspaceSocket(ctx.requireUser().id, ctx.params["workspaceId"]!)); }
      catch (error) { return sshKeyAccessErrorResponse(error); }
    },
  },
  "/api/ssh-key-access/provisioning-leases/:leaseId": {
    auth: "user", sameOrigin: "mutations",
    description: "Revoke an owned initial-clone SSH-key lease immediately.",
    tags: ["ssh-key-access"], operations: { DELETE: { requestSchema: undefined, querySchema: undefined, automation: change } },
    async DELETE(_req, ctx) {
      try { await revokeProvisioningSshKeyLease(ctx.requireUser().id, ctx.params["leaseId"]!); return Response.json({ success: true }); }
      catch (error) { return sshKeyAccessErrorResponse(error); }
    },
  },
  "/api/execution-hosts/:kind/:id/ssh-key-access": {
    auth: "user", sameOrigin: "mutations",
    description: "List shared SSH keys explicitly granted to direct execution on this owned registered server. Workspaces have separate grants.",
    tags: ["ssh-key-access", "execution-hosts"], operations: { GET: read },
    async GET(_req, ctx) {
      try { return Response.json(await sshKeyAccessService.hostAccess(ctx.requireUser().id, hostFromParams(ctx.params))); }
      catch (error) { return sshKeyAccessErrorResponse(error); }
    },
  },
  "/api/execution-hosts/:kind/:id/ssh-key-access/:keyId": {
    auth: "user", sameOrigin: "mutations",
    description: "Enable or revoke a shared SSH key for direct commands, terminals and chats on this registered server, without granting it to workspaces or changing local keys.",
    tags: ["ssh-key-access", "execution-hosts"], requestSchema: SetWorkspaceSshKeyGrantSchema,
    operations: { PUT: { requestSchema: SetWorkspaceSshKeyGrantSchema, querySchema: undefined, automation: change } },
    async PUT(req, ctx) {
      const parsed = await parseAndValidate(SetWorkspaceSshKeyGrantSchema, req);
      if (!parsed.success) return parsed.response;
      try {
        const result = await sshKeyAccessService.setHostGrant(ctx.requireUser().id, hostFromParams(ctx.params), ctx.params["keyId"]!, parsed.data.enabled);
        ctx.userRealtime.publishChanged("ssh-key-access");
        return Response.json(result);
      } catch (error) { return sshKeyAccessErrorResponse(error); }
    },
  },
});
