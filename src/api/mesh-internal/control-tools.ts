import { defineRoutes } from "@pablozaiden/webapp/server";
import { MeshControlToolRequestSchema } from "@/contracts/schemas/control-tool-transport";
import { CONTROL_REQUEST_MAX_BYTES } from "@/contracts/schemas/control";
import { dispatchControlTool, requestControlTool } from "../../core/control-tool-transport";
import { assertMeshRequestTransport } from "../../core/mesh-transport-security";
import { getMeshRelayRequestInitiatorNodeId } from "../../core/mesh-relay-http";
import { requireMeshRuntimeRole } from "../../core/mesh-runtime";
import { controlErrorResponse } from "../control";
import { errorResponse } from "../helpers";
import { parseAndValidate } from "../validation";
import { validateMeshIdentityHeaders } from "./shared";

export const meshControlToolRoutes = defineRoutes({
  "/api/mesh/internal/control-tools": {
    // The scoped execution credential is authenticated by the common control
    // owner; relay streams deliberately do not forward Authorization headers.
    auth: "public", sameOrigin: "never", tags: ["mesh", "internal", "control"],
    description: "Dispatch execution-owned control tools over the registered Mesh route.",
    operations: {
      POST: { automation: { policy: "excluded", reason: "Internal execution-authenticated Mesh control transport." } },
    },
    async POST(req, ctx): Promise<Response> {
      ctx.server?.timeout(req, 0);
      const parsed = await parseAndValidate(MeshControlToolRequestSchema, req, {
        maxBodyBytes: CONTROL_REQUEST_MAX_BYTES + 8192,
      });
      if (!parsed.success) return parsed.response;
      const envelope = parsed.data;
      const headerError = validateMeshIdentityHeaders(req, envelope.workerNodeId, envelope.requestId, "Mesh control headers do not match the execution request.");
      if (headerError) return headerError;
      const initiator = getMeshRelayRequestInitiatorNodeId(req);
      if (initiator !== undefined && initiator !== envelope.workerNodeId) {
        return errorResponse("control_origin_invalid", "The relay origin does not match the execution worker.", 403);
      }
      try {
        assertMeshRequestTransport(req, envelope.protocolVersion);
        requireMeshRuntimeRole("controller");
        const payload = await requestControlTool({
          credential: envelope.credential,
          request: async (request, signal) => await dispatchControlTool(envelope.credential, request, signal, envelope.workerNodeId),
        }, envelope.request, req.signal);
        return Response.json({ protocolVersion: envelope.protocolVersion, requestId: envelope.requestId, payload }, {
          headers: { "Cache-Control": "no-store" },
        });
      } catch (error) { return controlErrorResponse(error); }
    },
  },
});
