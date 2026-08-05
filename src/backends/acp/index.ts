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
export type { AcpBackendOptions } from "./acp-backend";
export type {
  AcpTransportClosedEvent,
  AcpTransportCloseReason,
  AcpTransportLifecycle,
  AcpTransportLifecycleFactory,
  AcpTransportSession,
  RpcNotificationSink,
  RpcPendingController,
  RpcRequester,
  RpcTransport,
} from "./contracts";
export { LocalAcpTransportLifecycle } from "./transport-lifecycle";
export { MeshAcpTransport, WorkspaceAcpTransportLifecycle } from "./mesh-transport";
export { getMockAcpCommand } from "./mock-acp-command";
