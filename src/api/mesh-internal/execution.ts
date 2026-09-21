import { defineRoutes } from "@pablozaiden/webapp/server";
import {
  MeshExecutionAsyncCommandRequestSchema,
  MeshExecutionRpcRequestSchema,
  MeshExecutionFileWriteQuerySchema,
  MeshExecutionSessionCloseRequestSchema,
  MeshExecutionSessionRequestSchema,
} from "@/contracts/schemas/mesh-execution";
import { MESH_ACP_CHANNEL } from "@/shared/mesh-execution";
import { meshExecutionGateway } from "../../core/mesh-execution-gateway";
import { meshAcpGateway } from "../../core/mesh-acp-gateway";
import { encryptMeshPayload } from "../../core/mesh-payload-crypto";
import { DomainError } from "../../domain/domain-error";
import { requireMeshRuntimeRole } from "../../core/mesh-runtime";
import { errorResponse } from "../helpers";
import { parseAndValidate, validateRequest } from "../validation";
import {
  internalMeshErrorResponse,
  validateMeshIdentityHeaders,
  validateMeshSessionHeaders,
} from "./shared";

export const meshExecutionRoutes = defineRoutes({
  "/api/mesh/internal/execution/session": {
    auth: "public",
    sameOrigin: "never",
    description: "Establish a signed, short-lived mesh CommandExecutor session.",
    tags: ["mesh", "internal", "execution"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshExecutionSessionRequestSchema, req);
      if (!parsed.success) return parsed.response;
      if (parsed.data.callerEncryptionPublicKey.trim().length === 0) {
        return errorResponse(
          "mesh_execution_encryption_key_invalid",
          "A non-empty caller encryption public key is required.",
          400,
        );
      }
      const headerError = validateMeshIdentityHeaders(
        req,
        parsed.data.callerNodeId,
        parsed.data.requestId,
        "Mesh identity headers do not match the execution session.",
      );
      if (headerError) return headerError;
      try {
        requireMeshRuntimeRole("worker");
        const session = await meshExecutionGateway.createSession(parsed.data);
        if (req.signal.aborted) {
          meshExecutionGateway.releaseSession(session.sessionId, session.sessionToken);
          throw new DomainError(
            "mesh_execution_aborted",
            "Mesh execution session creation was aborted.",
          );
        }
        return Response.json({
          protocolVersion: session.protocolVersion,
          sessionId: session.sessionId,
          expiresAt: session.expiresAt,
          encryptedPayload: encryptMeshPayload(
            {
              sessionToken: session.sessionToken,
              executionRoot: session.executionRoot,
            },
            parsed.data.callerEncryptionPublicKey,
          ),
        });
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
    async DELETE(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshExecutionSessionCloseRequestSchema, req);
      if (!parsed.success) return parsed.response;
      const headerError = validateMeshSessionHeaders(
        req,
        parsed.data.sessionId,
        parsed.data.requestId,
        "Mesh headers do not match the execution session release.",
      );
      if (headerError) return headerError;
      try {
        requireMeshRuntimeRole("worker");
        const channel = meshExecutionGateway.releaseSession(
          parsed.data.sessionId,
          parsed.data.sessionToken,
        );
        if (channel === MESH_ACP_CHANNEL) {
          await meshAcpGateway.close(parsed.data.sessionId);
        }
        return Response.json({ success: true });
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
  "/api/mesh/internal/execution/rpc": {
    auth: "public",
    sameOrigin: "never",
    description: "Execute a bounded CommandExecutor operation in a mesh session.",
    tags: ["mesh", "internal", "execution"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshExecutionRpcRequestSchema, req);
      if (!parsed.success) return parsed.response;
      const headerError = validateMeshSessionHeaders(
        req,
        parsed.data.sessionId,
        parsed.data.requestId,
        "Mesh headers do not match the execution RPC.",
      );
      if (headerError) return headerError;
      try {
        const encryptionPublicKey = meshExecutionGateway.getSessionEncryptionPublicKey(
          parsed.data.sessionId,
          parsed.data.sessionToken,
        );
        const result = await meshExecutionGateway.execute(parsed.data, req.signal);
        return Response.json({
          protocolVersion: parsed.data.protocolVersion,
          requestId: parsed.data.requestId,
          encryptedPayload: encryptMeshPayload(result, encryptionPublicKey),
        });
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
  "/api/mesh/internal/execution/async": {
    auth: "public",
    sameOrigin: "never",
    description: "Start, inspect, or cancel a long-running mesh command.",
    tags: ["mesh", "internal", "execution"],
    async POST(req): Promise<Response> {
      const parsed = await parseAndValidate(MeshExecutionAsyncCommandRequestSchema, req);
      if (!parsed.success) return parsed.response;
      const headerError = validateMeshSessionHeaders(
        req,
        parsed.data.sessionId,
        parsed.data.requestId,
        "Mesh headers do not match the asynchronous execution request.",
      );
      if (headerError) return headerError;
      try {
        requireMeshRuntimeRole("worker");
        const encryptionPublicKey = meshExecutionGateway.getSessionEncryptionPublicKey(
          parsed.data.sessionId,
          parsed.data.sessionToken,
        );
        const snapshot = parsed.data.action === "start"
          ? await meshExecutionGateway.startAsyncCommand(parsed.data)
          : parsed.data.action === "status"
            ? await meshExecutionGateway.getAsyncCommand(
                parsed.data.sessionId,
                parsed.data.sessionToken,
                parsed.data.jobId ?? "",
                parsed.data.requestId,
                parsed.data.stdoutOffset,
                parsed.data.stderrOffset,
              )
            : await meshExecutionGateway.cancelAsyncCommand(
                parsed.data.sessionId,
                parsed.data.sessionToken,
                parsed.data.jobId ?? "",
                parsed.data.requestId,
                parsed.data.stdoutOffset,
                parsed.data.stderrOffset,
              );
        return Response.json({
          protocolVersion: parsed.data.protocolVersion,
          requestId: parsed.data.requestId,
          encryptedPayload: encryptMeshPayload(snapshot, encryptionPublicKey),
        });
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
  "/api/mesh/internal/execution/file": {
    auth: "public",
    sameOrigin: "never",
    description: "Stream a file from an authenticated Mesh CommandExecutor session.",
    tags: ["mesh", "internal", "execution"],
    async GET(req): Promise<Response> {
      const sessionId = req.headers.get("x-clanky-mesh-session-id");
      const sessionToken = req.headers.get("x-clanky-mesh-session-token");
      const requestedPath = new URL(req.url).searchParams.get("path");
      if (!sessionId || !sessionToken) {
        return errorResponse("mesh_execution_session_invalid", "Mesh execution session headers are required.", 401);
      }
      if (!requestedPath) {
        return errorResponse("mesh_execution_request_invalid", "A file path is required.", 400);
      }
      try {
        const stream = await meshExecutionGateway.streamFile(
          sessionId,
          sessionToken,
          requestedPath,
          req.signal,
        );
        if (!stream) {
          return errorResponse("file_not_found", "Requested file does not exist", 404);
        }
        return new Response(stream, {
          headers: {
            "cache-control": "no-store",
            "content-type": "application/octet-stream",
          },
        });
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
    async POST(req): Promise<Response> {
      const validation = validateRequest(
        MeshExecutionFileWriteQuerySchema,
        Object.fromEntries(new URL(req.url).searchParams.entries()),
      );
      if (!validation.success) {
        return validation.response;
      }
      const sessionId = req.headers.get("x-clanky-mesh-session-id");
      const sessionToken = req.headers.get("x-clanky-mesh-session-token");
      if (!sessionId || !sessionToken) {
        return errorResponse("mesh_execution_session_invalid", "Mesh execution session headers are required.", 401);
      }
      if (!req.body) {
        return errorResponse("mesh_execution_request_invalid", "A file write body is required.", 400);
      }
      try {
        const result = await meshExecutionGateway.writeFileStream(
          sessionId,
          sessionToken,
          validation.data.path,
          req.body,
          {
            append: validation.data.append,
            expectedOffset: validation.data.expectedOffset,
            maxBytes: validation.data.maxBytes,
          },
          req.signal,
        );
        return Response.json(result);
      } catch (error) {
        return internalMeshErrorResponse(error);
      }
    },
  },
});
