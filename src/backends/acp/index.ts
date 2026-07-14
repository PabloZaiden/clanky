/**
 * ACP backend barrel re-export.
 */

// Re-export ConnectionInfo for backward compatibility
export type { ConnectionInfo } from "../types";

export {
  AcpError,
  createAcpProcessError,
  createAcpRpcError,
  createAcpSessionNotFoundError,
  getAcpErrorMessage,
  isAcpError,
  isAcpErrorCode,
} from "./errors";
export type { AcpErrorCode } from "./errors";
export { sanitizeSpawnArgsForLogging } from "./process-utils";
export { AcpBackend } from "./acp-backend";
export { getMockAcpCommand } from "./mock-acp-command";
