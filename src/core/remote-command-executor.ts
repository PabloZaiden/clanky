/**
 * Command executor for deterministic local command and file operations.
 * Uses direct process execution and does not depend on any agent SDK transport.
 *
 * Re-exports from sub-modules in ./remote-executor/
 */

export type { CommandExecutorConfig } from "./remote-executor/types";
export { CommandExecutorImpl } from "./remote-executor/executor";
