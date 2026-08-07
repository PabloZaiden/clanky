/**
 * ACP backend barrel re-export.
 */

export {
  AcpError,
  createAcpConnectionAbortedError,
  createAcpConnectionTimeoutError,
  createAcpProcessError,
  createAcpRpcError,
  createAcpSessionNotFoundError,
  createAcpUnsupportedPromptCapabilityError,
  getAcpErrorMessage,
  isAcpSshTransportFailure,
  isAcpSshTransportFailureMetadata,
  isAcpError,
  isAcpErrorCode,
} from "./errors";
export type { AcpErrorCode, RpcErrorLike } from "./errors";
export {
  isSshAuthenticationFailureExit,
  sanitizeSpawnArgsForLogging,
} from "./process-utils";
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
export type { AcpAuthenticationMode, AcpProcessExit, AcpTransportStage } from "./types";
export { LocalAcpTransportLifecycle } from "./transport-lifecycle";
export { MeshAcpTransport, WorkspaceAcpTransportLifecycle } from "./mesh-transport";
export { getMockAcpCommand } from "./mock-acp-command";
