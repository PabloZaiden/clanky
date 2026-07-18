/**
 * ACP backend barrel re-export.
 */

export {
  AcpError,
  createAcpProcessError,
  createAcpRpcError,
  createAcpSessionNotFoundError,
  createAcpUnsupportedPromptCapabilityError,
  getAcpErrorMessage,
  isAcpError,
  isAcpErrorCode,
} from "./errors";
export type { AcpErrorCode } from "./errors";
export { sanitizeSpawnArgsForLogging } from "./process-utils";
export { AcpBackend } from "./acp-backend";
export { getMockAcpCommand } from "./mock-acp-command";
