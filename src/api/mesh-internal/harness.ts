/**
 * Deliberately public framework routes: peer controllers authenticate with
 * signed execution grants and encrypted, short-lived, owned native leases.
 */
import { defineRoutes } from "@pablozaiden/webapp/server";
import { MeshHarnessEnvelopeSchema, MeshHarnessEventsRequestSchema, MeshHarnessOperationSchema } from "@/contracts/schemas/mesh-harness";
import { meshHarnessGateway } from "../../core/mesh-harness-gateway";
import { meshExecutionGateway } from "../../core/mesh-execution-gateway";
import { encryptMeshPayload, decryptMeshPayload } from "../../core/mesh-payload-crypto";
import { MESH_HARNESS_CHANNEL, MESH_EXECUTION_MAX_MESSAGE_BYTES } from "@/shared/mesh-execution";
import { DomainError } from "../../domain/domain-error";
import { parseAndValidate } from "../validation";
import { internalMeshErrorResponse, validateMeshSessionHeaders } from "./shared";
import { errorResponse } from "../helpers";

export const meshHarnessRoutes = defineRoutes({
  "/api/mesh/internal/harness/rpc": {
    auth: "public", sameOrigin: "never",
    description: "Operate an owned native harness on a v6 Mesh execution host.",
    tags: ["mesh", "internal", "harness"],
    async POST(req, ctx): Promise<Response> {
      ctx.server?.timeout(req, 0);
      const parsed = await parseAndValidate(MeshHarnessEnvelopeSchema, req);
      if (!parsed.success) return parsed.response;
      const envelope = parsed.data;
      const headerError = validateMeshSessionHeaders(req, envelope.sessionId, envelope.requestId, "Native Mesh headers do not match the lease.");
      if (headerError) return headerError;
      let release: (() => void) | undefined;
      try {
        release = await meshExecutionGateway.claimHarnessRequest(envelope.sessionId, envelope.sessionToken, envelope.requestId);
        const encryptionKey = meshExecutionGateway.getSessionEncryptionPublicKey(envelope.sessionId, envelope.sessionToken);
        const raw = await decryptMeshPayload(envelope.encryptedPayload);
        if (Buffer.byteLength(JSON.stringify(raw)) > MESH_EXECUTION_MAX_MESSAGE_BYTES) throw new DomainError("mesh_execution_request_too_large", "The native operation exceeds the Mesh limit.");
        const operation = MeshHarnessOperationSchema.safeParse(raw);
        if (!operation.success) return errorResponse("mesh_execution_request_invalid", "The native operation is invalid.", 400);
        const result = await meshHarnessGateway.execute(envelope.sessionId, envelope.sessionToken, operation.data, req.signal);
        if (Buffer.byteLength(JSON.stringify(result)) > MESH_EXECUTION_MAX_MESSAGE_BYTES) throw new DomainError("mesh_execution_result_too_large", "The native result exceeds the Mesh limit.");
        return Response.json({
          protocolVersion: 6, requestId: envelope.requestId,
          encryptedPayload: encryptMeshPayload(result, encryptionKey),
        });
      } catch (error) { return internalMeshErrorResponse(error); }
      finally { release?.(); }
    },
  },
  "/api/mesh/internal/harness/events": {
    auth: "public", sameOrigin: "never",
    description: "Observe an owned native conversation for its whole lifetime.",
    tags: ["mesh", "internal", "harness"],
    async POST(req, ctx): Promise<Response> {
      ctx.server?.timeout(req, 0);
      const parsed = await parseAndValidate(MeshHarnessEventsRequestSchema, req);
      if (!parsed.success) return parsed.response;
      const envelope = parsed.data;
      const headerError = validateMeshSessionHeaders(req, envelope.sessionId, envelope.requestId, "Native Mesh headers do not match the event lease.");
      if (headerError) return headerError;
      try {
        const key = meshExecutionGateway.getSessionEncryptionPublicKey(envelope.sessionId, envelope.sessionToken);
        const subscription = await meshHarnessGateway.subscribe(envelope.sessionId, envelope.sessionToken, envelope.conversationId);
        let sequence = 0;
        let closed = false;
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const encoder = new TextEncoder();
        const close = (): void => {
          if (closed) return;
          closed = true;
          subscription.close();
          clearInterval(heartbeat);
          req.signal.removeEventListener("abort", close);
          if (req.signal.aborted) meshHarnessGateway.observationTransportClosed(envelope.sessionId, envelope.conversationId);
        };
        req.signal.addEventListener("abort", close, { once: true });
        const stream = new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(encoder.encode(`${JSON.stringify({
              protocolVersion: 6, sequence: sequence++, encryptedPayload: encryptMeshPayload({ type: "ready" }, key),
            })}\n`));
            heartbeat = setInterval(() => {
              if (closed) return;
              if ((controller.desiredSize ?? 0) <= 0) {
                close();
                meshExecutionGateway.closeSession(envelope.sessionId);
                controller.error(new DomainError("harness_event_gap", "The native observation consumer exceeded its buffer."));
                return;
              }
              controller.enqueue(encoder.encode(`${JSON.stringify({
                protocolVersion: 6, sequence: sequence++, encryptedPayload: encryptMeshPayload({ type: "heartbeat" }, key),
              })}\n`));
            }, 15_000);
            heartbeat.unref?.();
          },
          async pull(controller): Promise<void> {
            try {
              const event = await subscription.next();
              if (!event) { close(); controller.close(); return; }
              controller.enqueue(encoder.encode(`${JSON.stringify({
                protocolVersion: 6, sequence: sequence++, encryptedPayload: encryptMeshPayload({ type: "event", event }, key),
              })}\n`));
            } catch (error) { close(); controller.error(error); }
          },
          cancel(): void {
            if (closed) return;
            close();
            meshHarnessGateway.observationTransportClosed(envelope.sessionId, envelope.conversationId);
          },
        }, { highWaterMark: 1 });
        return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
      } catch (error) { return internalMeshErrorResponse(error); }
    },
  },
  "/api/mesh/internal/harness/renew": {
    auth: "public", sameOrigin: "never",
    description: "Renew a native v6 Mesh execution lease without replacing its binding.",
    tags: ["mesh", "internal", "harness"],
    async POST(req): Promise<Response> {
      const id = req.headers.get("x-clanky-mesh-session-id");
      const token = req.headers.get("x-clanky-mesh-session-token");
      if (!id || !token) return errorResponse("mesh_execution_session_invalid", "Native lease headers are required.", 401);
      try {
        const expiresAt = await meshExecutionGateway.renewSession(id, token, MESH_HARNESS_CHANNEL);
        return Response.json({ protocolVersion: 6, sessionId: id, expiresAt: new Date(expiresAt).toISOString() });
      } catch (error) { return internalMeshErrorResponse(error); }
    },
  },
});
