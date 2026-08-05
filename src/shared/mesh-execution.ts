/**
 * Transport-neutral contracts for execution on a mesh-owned workspace.
 */

export const MESH_EXECUTION_PROTOCOL_VERSION = 1 as const;
export const MESH_EXECUTION_CHANNEL = "command-executor" as const;
export const MESH_ACP_CHANNEL = "acp" as const;
export const MESH_EXECUTION_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const MESH_EXECUTION_SESSION_TTL_MS = 60_000;
export const MESH_ACP_SESSION_TTL_MS = 30 * 60 * 1000;
export const MESH_EXECUTION_SESSION_REQUEST_TTL_MS = 45_000;
export const MESH_EXECUTION_SESSION_REQUEST_TIMEOUT_MS = 10_000;
export const MESH_EXECUTION_MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
export const MESH_EXECUTION_MAX_RESULT_BYTES = 8 * 1024 * 1024;
export const MESH_EXECUTION_MAX_RPC_TIMEOUT_MS = MESH_EXECUTION_DEFAULT_TIMEOUT_MS;
export const MESH_ACP_WEBSOCKET_OPEN_TIMEOUT_MS = 10_000;

export const MESH_EXECUTION_OPERATIONS = [
  "exec",
  "fileExists",
  "directoryExists",
  "readFile",
  "listDirectory",
  "writeFile",
] as const;
export type MeshExecutionOperation = typeof MESH_EXECUTION_OPERATIONS[number];
