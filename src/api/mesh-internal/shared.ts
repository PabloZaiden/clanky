import { domainErrorResponse, errorResponse } from "../helpers";

export function internalMeshErrorResponse(error: unknown): Response {
  return domainErrorResponse(error, {
    policy: "mesh-internal",
    fallback: {
      error: "mesh_internal_request_failed",
      message: "Mesh internal request failed",
      status: 500,
    },
  });
}

function validateMeshHeaders(
  req: Request,
  identifierHeader: string,
  expectedNodeId: string,
  expectedRequestId: string,
  message: string,
): Response | undefined {
  const nodeId = req.headers.get(identifierHeader);
  const requestId = req.headers.get("x-clanky-mesh-request-id");
  if (nodeId === expectedNodeId && requestId === expectedRequestId) {
    return undefined;
  }
  return errorResponse("mesh_peer_headers_invalid", message, 400);
}

export function validateMeshIdentityHeaders(
  req: Request,
  expectedNodeId: string,
  expectedRequestId: string,
  message: string,
): Response | undefined {
  return validateMeshHeaders(
    req,
    "x-clanky-mesh-node-id",
    expectedNodeId,
    expectedRequestId,
    message,
  );
}

export function validateMeshSessionHeaders(
  req: Request,
  expectedSessionId: string,
  expectedRequestId: string,
  message: string,
): Response | undefined {
  return validateMeshHeaders(
    req,
    "x-clanky-mesh-session-id",
    expectedSessionId,
    expectedRequestId,
    message,
  );
}
