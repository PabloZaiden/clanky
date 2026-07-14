import { DomainError, type DomainErrorOptions } from "../../core/domain-error";

export type AcpErrorCode =
  | "acp_request_failed"
  | "acp_request_cancelled"
  | "acp_method_not_found"
  | "acp_session_not_found"
  | "acp_request_timed_out"
  | "acp_process_failed"
  | "acp_ssh_authentication_failed";

export class AcpError<TCode extends AcpErrorCode = AcpErrorCode> extends DomainError<TCode> {
  constructor(code: TCode, message: string, options: DomainErrorOptions = {}) {
    super(code, message, options);
    this.name = "AcpError";
  }
}

export function isAcpError(error: unknown): error is AcpError {
  return error instanceof AcpError;
}

export function isAcpErrorCode<TCode extends AcpErrorCode>(
  error: unknown,
  code: TCode,
): error is AcpError<TCode> {
  return isAcpError(error) && error.code === code;
}

export function getAcpErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface RpcErrorLike {
  code?: number;
  message?: string;
}

export function createAcpRpcError(error: RpcErrorLike): AcpError {
  const message = error.message ?? "ACP request failed";
  const options = error.code === undefined
    ? {}
    : { details: { rpcCode: error.code } };

  if (error.code === -32800) {
    return new AcpError("acp_request_cancelled", message, options);
  }
  if (error.code === -32601) {
    return new AcpError("acp_method_not_found", message, options);
  }

  const normalized = message.toLowerCase();
  if (
    normalized.includes("session")
    && (normalized.includes("not found") || normalized.includes("unknown session"))
  ) {
    return new AcpError("acp_session_not_found", message, options);
  }
  if (normalized.includes("method not found")) {
    return new AcpError("acp_method_not_found", message, options);
  }

  return new AcpError("acp_request_failed", message, options);
}

export function createAcpSessionNotFoundError(
  sessionId: string,
  options: DomainErrorOptions = {},
): AcpError<"acp_session_not_found"> {
  return new AcpError("acp_session_not_found", `Session ${sessionId} not found`, options);
}

export function createAcpProcessError(
  reason: string,
  options: {
    command?: string;
    exitCode?: number;
    cause?: unknown;
  } = {},
): AcpError {
  const details = {
    ...(options.command ? { command: options.command } : {}),
    ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
  };
  const isSshAuthenticationFailure =
    options.exitCode === 255
    && reason.includes("Permission denied (publickey,password,keyboard-interactive)");
  const code = isSshAuthenticationFailure
    ? "acp_ssh_authentication_failed"
    : "acp_process_failed";

  return new AcpError(code, reason, {
    ...(Object.keys(details).length > 0 ? { details } : {}),
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  });
}
