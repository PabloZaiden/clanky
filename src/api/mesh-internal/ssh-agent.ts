import { defineRoutes } from "@/platform/server";
import { parseSshMeshRequest, signSshMeshResponse, verifySshMeshRequest } from "../../core/ssh-agent-mesh";
import { receiveSshAgentOperation } from "../../core/ssh-key-access-service";
import { assertMeshRequestTransport } from "../../core/mesh-transport-security";
import { getMeshRelayRequestInitiatorNodeId } from "../../core/mesh-relay-http";
import { sshAgentError } from "../../core/ssh-agent-protocol";
import { validateMeshIdentityHeaders } from "./shared";
import { sshKeyAccessErrorResponse } from "../ssh-key-access";

export const meshSshAgentRoutes = defineRoutes({
  "/api/mesh/internal/ssh-agent": {
    // Nodes have no browser session. Every bounded request instead requires
    // a fresh node signature and active registered controller/worker grant.
    auth: "public", sameOrigin: "never",
    description: "Exchange capability-negotiated, signed scoped SSH-agent requests.",
    tags: ["mesh", "internal", "ssh-key-access"],
    operations: { POST: { requestSchema: undefined, querySchema: undefined,
      automation: { policy: "excluded", reason: "Signed internal scoped SSH-agent protocol; not a user API or generic forwarding route." } } },
    async POST(req) {
      try {
        assertMeshRequestTransport(req, 7);
        const body = await parseSshMeshRequest(req);
        const error = validateMeshIdentityHeaders(req, body.senderNodeId, body.requestId, "Mesh SSH-agent headers do not match the signed identity.");
        if (error) return error;
        const initiator = getMeshRelayRequestInitiatorNodeId(req);
        if (initiator !== undefined && initiator !== body.senderNodeId) throw sshAgentError("access_denied", "The Mesh relay initiator does not match the SSH-agent sender.");
        const verifiedPublicKey = await verifySshMeshRequest(body);
        return Response.json(await signSshMeshResponse(body, await receiveSshAgentOperation(body, verifiedPublicKey)));
      } catch (error) { return sshKeyAccessErrorResponse(error); }
    },
  },
});
