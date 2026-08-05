/**
 * Transport-neutral contracts for execution on a mesh-owned workspace.
 */

export const MESH_EXECUTION_PROTOCOL_VERSION = 1 as const;
export const MESH_EXECUTION_CHANNEL = "command-executor" as const;
export const MESH_ACP_CHANNEL = "acp" as const;

export const MESH_EXECUTION_OPERATIONS = [
  "exec",
  "fileExists",
  "directoryExists",
  "readFile",
  "listDirectory",
  "writeFile",
] as const;
export type MeshExecutionOperation = typeof MESH_EXECUTION_OPERATIONS[number];
