import { DomainError } from "./domain-error";

const MESH_CONTROL_REQUEST_TIMEOUT_MS = 10_000;

function getSenderNodeId(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return "";
  }
  const record = payload as Record<string, unknown>;
  if ("requestedNodeId" in record) {
    return String(record["requestedNodeId"]);
  }
  if ("approvedByNodeId" in record) {
    return String(record["approvedByNodeId"]);
  }
  if ("senderNodeId" in record) {
    return String(record["senderNodeId"]);
  }
  return "";
}

export async function postMeshControlMessage(
  endpoint: string,
  payload: unknown,
  requestId: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MESH_CONTROL_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clanky-mesh-node-id": getSenderNodeId(payload),
        "x-clanky-mesh-request-id": requestId,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new DomainError("mesh_control_request_rejected", "The peer rejected the mesh control request.", {
        details: { status: response.status, requestId },
      });
    }
    return response;
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw new DomainError("mesh_control_request_unreachable", "The mesh peer could not be reached.", {
      cause: error,
      details: { requestId },
    });
  } finally {
    clearTimeout(timeout);
  }
}
