import type { WorkspaceConnectionStatus } from "@/shared/collaboration";

export function isControllerUnavailable(entry: WorkspaceConnectionStatus): boolean {
  return entry.connection.status === "active"
    && (entry.transport !== "connected" || entry.realtime !== "connected"
      || entry.errorCode !== null || entry.operationErrorCode !== null);
}

export function controllerStatusLabel(entry: WorkspaceConnectionStatus): string {
  if (entry.connection.status === "revoked") return "Access revoked";
  if (entry.errorCode === "collaboration_connection_in_use") return "Open in another tab";
  if (entry.connection.status === "pending") return "Pairing pending";
  return isControllerUnavailable(entry) ? "Unavailable" : "Connected";
}
