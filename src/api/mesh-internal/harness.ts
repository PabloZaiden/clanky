/**
 * Deliberately public framework routes: peer controllers authenticate with
 * signed execution grants and short-lived, owned native leases over TLS.
 */
import { defineRoutes } from "@pablozaiden/webapp/server";
import { MeshHarnessEnvelopeSchema, MeshHarnessEventsRequestSchema } from "@/contracts/schemas/mesh-harness";
import { meshHarnessGateway } from "../../core/mesh-harness-gateway";
import { meshExecutionGateway } from "../../core/mesh-execution-gateway";
import {
  MESH_HARNESS_CHANNEL,
  MESH_EXECUTION_MAX_MESSAGE_BYTES,
  MESH_HARNESS_MAX_OPERATION_BYTES,
  MESH_HARNESS_MAX_REQUEST_BYTES,
} from "@/shared/mesh-execution";
import { DomainError } from "../../domain/domain-error";
import { parseAndValidate } from "../validation";
import { assertMeshExecutionTransport, internalMeshErrorResponse, validateMeshSessionHeaders } from "./shared";
import { createHarnessEventStream } from "./harness-events";
import { errorResponse } from "../helpers";

export const meshHarnessRoutes = defineRoutes({
  "/api/mesh/internal/harness/rpc": {
    auth: "public", sameOrigin: "never",
    description: "Operate an owned native harness on a supported Mesh execution host.",
    operations: {
      POST: { requestSchema: undefined, querySchema: undefined, automation: { policy: "excluded", reason: "Internal authenticated native-harness RPC transport." } },
    },
    tags: ["mesh", "internal", "harness"],
    async POST(req, ctx): Promise<Response> {
      ctx.server?.timeout(req, 0);
      const parsed = await parseAndValidate(MeshHarnessEnvelopeSchema, req, {
        maxBodyBytes: MESH_HARNESS_MAX_REQUEST_BYTES,
      });
      if (!parsed.success) return parsed.response;
      const envelope = parsed.data;
      const headerError = validateMeshSessionHeaders(req, envelope.sessionId, envelope.requestId, "Native Mesh headers do not match the lease.");
      if (headerError) return headerError;
      let release: (() => void) | undefined;
      try {
        assertMeshExecutionTransport(req, envelope);
        const controlReply = envelope.payload.operation === "control.result";
        release = await meshExecutionGateway.claimHarnessRequest(envelope.sessionId, envelope.sessionToken, envelope.requestId, controlReply);
        const maxBytes = controlReply ? 1024 * 1024 + 8192 : MESH_HARNESS_MAX_OPERATION_BYTES;
        if (Buffer.byteLength(JSON.stringify(envelope.payload)) > maxBytes) throw new DomainError("mesh_execution_request_too_large", "The native Mesh harness request exceeds the supported size limit.");
        const result = await meshHarnessGateway.execute(envelope.sessionId, envelope.sessionToken, envelope.payload, req.signal);
        if (Buffer.byteLength(JSON.stringify(result)) > MESH_EXECUTION_MAX_MESSAGE_BYTES) throw new DomainError("mesh_execution_result_too_large", "The native result exceeds the Mesh limit.");
        return Response.json({
          protocolVersion: envelope.protocolVersion, requestId: envelope.requestId,
          payload: result,
        });
      } catch (error) { return internalMeshErrorResponse(error); }
      finally { release?.(); }
    },
  },
  "/api/mesh/internal/harness/events": {
    auth: "public", sameOrigin: "never",
    description: "Observe an owned native conversation for its whole lifetime.",
    operations: {
      POST: { requestSchema: undefined, querySchema: undefined, automation: { policy: "excluded", reason: "Internal long-lived native-harness event stream." } },
    },
    tags: ["mesh", "internal", "harness"],
    async POST(req, ctx): Promise<Response> {
      ctx.server?.timeout(req, 0);
      const parsed = await parseAndValidate(MeshHarnessEventsRequestSchema, req);
      if (!parsed.success) return parsed.response;
      const envelope = parsed.data;
      const headerError = validateMeshSessionHeaders(req, envelope.sessionId, envelope.requestId, "Native Mesh headers do not match the event lease.");
      if (headerError) return headerError;
      try {
        assertMeshExecutionTransport(req, envelope);
        const control = "channel" in envelope;
        const subscription = control
          ? await meshHarnessGateway.subscribeControl(envelope.sessionId, envelope.sessionToken)
          : await meshHarnessGateway.subscribe(envelope.sessionId, envelope.sessionToken, envelope.conversationId);
        const stream = createHarnessEventStream({
          subscription,
          ...(control ? { channel: "control" as const } : {}),
          protocolVersion: envelope.protocolVersion,
          signal: req.signal,
          onObservationClosed: () => {
            if ("channel" in envelope) meshHarnessGateway.controlTransportClosed(envelope.sessionId);
            else meshHarnessGateway.observationTransportClosed(envelope.sessionId, envelope.conversationId);
          },
        });
        return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
      } catch (error) { return internalMeshErrorResponse(error); }
    },
  },
  "/api/mesh/internal/harness/renew": {
    auth: "public", sameOrigin: "never",
    description: "Renew a native Mesh execution lease without replacing its binding.",
    operations: {
      POST: { requestSchema: undefined, querySchema: undefined, automation: { policy: "excluded", reason: "Internal authenticated native-harness execution-lease protocol." } },
    },
    tags: ["mesh", "internal", "harness"],
    async POST(req): Promise<Response> {
      const id = req.headers.get("x-clanky-mesh-session-id");
      const token = req.headers.get("x-clanky-mesh-session-token");
      if (!id || !token) return errorResponse("mesh_execution_session_invalid", "Native lease headers are required.", 401);
      try {
        assertMeshExecutionTransport(req, { sessionId: id, sessionToken: token });
        const protocolVersion = meshExecutionGateway.getSessionProtocolVersion(id, token);
        const expiresAt = await meshExecutionGateway.renewSession(id, token, { expectedChannel: MESH_HARNESS_CHANNEL });
        return Response.json({ protocolVersion, sessionId: id, expiresAt: new Date(expiresAt).toISOString() });
      } catch (error) { return internalMeshErrorResponse(error); }
    },
  },
});
