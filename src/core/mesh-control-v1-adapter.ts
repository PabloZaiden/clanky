/**
 * Isolated callback adapter for enrolled v1 controllers during Mesh rollout.
 * Current controllers admit only v2 lease control and never select this path.
 */
import { getControllerGrant } from "../persistence/mesh";
import { ensureLocalMeshNodeIdentity } from "../persistence/mesh-node-identity";
import { requestMeshPeer } from "./mesh-peer-transport";
import { readMeshControlResponseJson } from "./mesh-control-client";
import type { ControlToolConnection } from "./control-tool-transport";
import { DomainError } from "../domain/domain-error";
import { MESH_PROTOCOL_VERSION, MESH_PROTOCOL_VERSION_HEADER } from "@/shared/mesh-protocol";
import { readMeshPayload } from "./mesh-payload";

export function legacyMeshControlConnection(controllerNodeId: string, credential: string): ControlToolConnection {
  return {
    request: async (request, signal) => {
      const grant = await getControllerGrant(controllerNodeId);
      if (grant?.grantStatus !== "active" || !grant.controllerRoute) {
        throw new DomainError("control_context_unavailable", "The execution controller route is unavailable.");
      }
      const worker = await ensureLocalMeshNodeIdentity();
      const requestId = crypto.randomUUID();
      try {
        const response = await requestMeshPeer(grant.controllerRoute, "api/mesh/internal/control-tools", {
          method: "POST", signal,
          headers: {
            "content-type": "application/json",
            [MESH_PROTOCOL_VERSION_HEADER]: String(MESH_PROTOCOL_VERSION),
            "x-clanky-mesh-node-id": worker.nodeId,
            "x-clanky-mesh-request-id": requestId,
          },
          body: JSON.stringify({
            protocolVersion: MESH_PROTOCOL_VERSION, requestId, workerNodeId: worker.nodeId, credential, request,
          }),
        });
        const body = await readMeshControlResponseJson(response, { signal, maxBytes: 1024 * 1024 + 4096 });
        if (!response.ok) {
          if (typeof body === "object" && body !== null && "ok" in body && body.ok === false
            && "code" in body && typeof body.code === "string" && /^[a-z][a-z0-9_]{0,100}$/.test(body.code)) {
            throw new DomainError(body.code, "The controller rejected the control request.", {
              details: { status: response.status, notExecuted: "completion" in body && body.completion === "not_executed" },
            });
          }
          throw new DomainError("control_unavailable", "The Mesh controller rejected the legacy control request.", {
            details: { status: response.status },
          });
        }
        if (typeof body !== "object" || body === null || !("protocolVersion" in body)
          || body.protocolVersion !== MESH_PROTOCOL_VERSION || !("requestId" in body) || body.requestId !== requestId
          || !("payload" in body)) {
          throw new DomainError("control_result_invalid", "The Mesh control response does not match its request.");
        }
        return readMeshPayload(body);
      } catch (error) {
        if (error instanceof DomainError) throw error;
        throw new DomainError("control_unavailable", "The registered legacy Mesh control route could not be reached.", { cause: error });
      }
    },
  };
}
