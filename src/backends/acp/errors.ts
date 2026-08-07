import { DomainError, type DomainErrorOptions } from "../../core/domain-error";
import type { AgentProvider } from "@/shared/settings";
import {
  SSHPASS_INVALID_PASSWORD_EXIT_CODE,
  type AcpAuthenticationMode,
  type AcpTransportStage,
  type JsonRpcError,
} from "./types";
import { classifyAcpRpcError } from "./provider-error-adapter";

export type AcpErrorCode =
  | "acp_request_failed"
  | "acp_request_cancelled"
  | "acp_method_not_found"
  | "acp_session_not_found"
  | "acp_request_timed_out"
  | "acp_process_failed"
  | "acp_transport_closed"
  | "acp_transport_unavailable"
  | "acp_transport_write_failed"
  | "acp_ssh_authentication_failed"
  | "acp_connection_timed_out"
  | "acp_connection_aborted"
  | "acp_unsupported_prompt_capability";

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

export type RpcErrorLike = JsonRpcError;

export function createAcpRpcError(
  error: RpcErrorLike,
  options: {
    method?: string;
    provider?: AgentProvider | null;
  } = {},
): AcpError {
  const message = error.message ?? "ACP request failed";
  const details: Record<string, unknown> = {
    ...(error.code === undefined ? {} : { rpcCode: error.code }),
    ...(error.data === undefined ? {} : { rpcData: error.data }),
    ...(options.provider ? { provider: options.provider } : {}),
  };
  const classification = classifyAcpRpcError({
    provider: options.provider ?? null,
    method: options.method ?? "",
    error,
  });
  if (classification) {
    details["providerSignal"] = classification.providerSignal;
  }
  const errorOptions = Object.keys(details).length > 0 ? { details } : {};

  if (error.code === -32800) {
    return new AcpError("acp_request_cancelled", message, errorOptions);
  }
  if (error.code === -32601) {
    return new AcpError("acp_method_not_found", message, errorOptions);
  }
  if (classification) {
    return new AcpError(classification.code, message, errorOptions);
  }

  return new AcpError("acp_request_failed", message, errorOptions);
}

export function createAcpSessionNotFoundError(
  sessionId: string,
  options: DomainErrorOptions = {},
): AcpError<"acp_session_not_found"> {
  return new AcpError("acp_session_not_found", `Session ${sessionId} not found`, options);
}

export function createAcpUnsupportedPromptCapabilityError(
  capability: string,
): AcpError<"acp_unsupported_prompt_capability"> {
  return new AcpError(
    "acp_unsupported_prompt_capability",
    `The connected ACP agent does not support the '${capability}' prompt capability required for this attachment.`,
    { details: { capability } },
  );
}

export function createAcpProcessError(
  reason: string,
  options: {
    command?: string;
    exitCode?: number;
    signalCode?: NodeJS.Signals | null;
    transport?: "stdio" | "ssh";
    authenticationMode?: AcpAuthenticationMode;
    authenticationFailure?: boolean;
    stage?: AcpTransportStage;
    attempt?: number;
    target?: {
      hostname?: string;
      port?: number;
      username?: string;
    };
    initializationCompleted?: boolean;
    cause?: unknown;
  } = {},
): AcpError {
  const details = {
    ...(options.command ? { command: options.command } : {}),
    ...(options.exitCode === undefined ? {} : { exitCode: options.exitCode }),
    ...(options.signalCode ? { signalCode: options.signalCode } : {}),
    ...(options.transport ? { transport: options.transport } : {}),
    ...(options.authenticationMode ? { authenticationMode: options.authenticationMode } : {}),
    ...(options.authenticationFailure === undefined
      ? {}
      : { authenticationFailure: options.authenticationFailure }),
    ...(options.stage ? { stage: options.stage } : {}),
    ...(options.attempt === undefined ? {} : { attempt: options.attempt }),
    ...(options.target ? { target: options.target } : {}),
    ...(options.initializationCompleted === undefined
      ? {}
      : { initializationCompleted: options.initializationCompleted }),
  };
  const isSshAuthenticationFailure =
    options.authenticationFailure === true
    || (
      options.command === "sshpass"
      && options.exitCode === SSHPASS_INVALID_PASSWORD_EXIT_CODE
    );
  const code = isSshAuthenticationFailure
    ? "acp_ssh_authentication_failed"
    : "acp_process_failed";

  return new AcpError(code, reason, {
    ...(Object.keys(details).length > 0 ? { details } : {}),
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  });
}

export function createAcpConnectionTimeoutError(
  timeoutMs: number,
  options: {
    transport?: "stdio" | "ssh";
    stage?: AcpTransportStage;
    target?: {
      hostname?: string;
      port?: number;
      username?: string;
    };
  } = {},
): AcpError<"acp_connection_timed_out"> {
  return new AcpError(
    "acp_connection_timed_out",
    `ACP connection timed out after ${timeoutMs}ms`,
    {
      details: {
        timeoutMs,
        ...(options.transport ? { transport: options.transport } : {}),
        ...(options.stage ? { stage: options.stage } : {}),
        ...(options.target ? { target: options.target } : {}),
      },
    },
  );
}

export function createAcpConnectionAbortedError(
  options: {
    transport?: "stdio" | "ssh";
    stage?: AcpTransportStage;
    target?: {
      hostname?: string;
      port?: number;
      username?: string;
    };
    cause?: unknown;
  } = {},
): AcpError<"acp_connection_aborted"> {
  return new AcpError(
    "acp_connection_aborted",
    "ACP connection was aborted",
    {
      details: {
        ...(options.transport ? { transport: options.transport } : {}),
        ...(options.stage ? { stage: options.stage } : {}),
        ...(options.target ? { target: options.target } : {}),
      },
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    },
  );
}

export function isAcpSshTransportFailure(error: unknown): boolean {
  if (!isAcpError(error)) {
    return false;
  }
  return isAcpSshTransportFailureMetadata(error.code, error.details);
}

export function isAcpSshTransportFailureMetadata(
  code: string | undefined,
  details: Readonly<Record<string, unknown>> | undefined,
): boolean {
  if (details?.["transport"] !== "ssh") {
    return false;
  }
  return (
    code === "acp_connection_timed_out"
    || code === "acp_connection_aborted"
    || code === "acp_process_failed"
    || code === "acp_transport_closed"
  );
}
