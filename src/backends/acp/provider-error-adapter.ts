/**
 * Provider and ACP protocol error adaptation.
 *
 * Recovery decisions must use structured protocol/provider signals. This
 * module is the only boundary that knows provider-specific error payloads.
 */

import { log } from "@pablozaiden/webapp/server";
import type { AgentProvider } from "@/shared/settings";
import type { AcpErrorCode, RpcErrorLike } from "./errors";

const ACP_RESOURCE_NOT_FOUND_ERROR_CODE = -32002;
const OPENCODE_INVALID_PARAMS_ERROR_CODE = -32602;
const SESSION_REFERENCING_METHODS: ReadonlySet<string> = new Set([
  "session/load",
  "session/prompt",
  "session/cancel",
  "session/delete",
  "session/set_model",
  "session/set_config_option",
  "session/set_mode",
  "session/fork",
  "session/close",
  "session/resume",
]);

type ProviderErrorClassification = {
  code: AcpErrorCode;
  providerSignal: string;
};

type ProviderErrorContext = {
  provider: AgentProvider | null;
  method: string;
  error: RpcErrorLike;
};

type ProviderErrorAdapter = (
  context: ProviderErrorContext,
) => ProviderErrorClassification | undefined;

const STRUCTURED_CATEGORY_KEYS = ["code", "errorCode", "kind", "type"] as const;
const SESSION_IDENTIFIER_KEYS = ["sessionId", "session_id"] as const;

/**
 * OpenCode reports a missing ACP session as JSON-RPC invalid params with the
 * missing session identifier in `data.sessionId`. Other provider rules belong
 * here only after their structured signal is documented.
 */
const PROVIDER_ERROR_ADAPTERS: Partial<Record<AgentProvider, ProviderErrorAdapter>> = {
  opencode: classifyOpenCodeError,
};

export function classifyAcpRpcError(
  context: ProviderErrorContext,
): ProviderErrorClassification | undefined {
  const structuredClassification = classifyStructuredError(context);
  if (structuredClassification) {
    return structuredClassification;
  }

  if (context.error.code === ACP_RESOURCE_NOT_FOUND_ERROR_CODE && isSessionMethod(context.method)) {
    return {
      code: "acp_session_not_found",
      providerSignal: "acp_resource_not_found",
    };
  }

  const adapter = context.provider ? PROVIDER_ERROR_ADAPTERS[context.provider] : undefined;
  return adapter?.(context);
}

function classifyStructuredError(
  context: ProviderErrorContext,
): ProviderErrorClassification | undefined {
  const structuredCategory = getStructuredCategory(context.error.data);
  if (!structuredCategory) {
    return undefined;
  }

  if (
    (structuredCategory === "session_not_found" || structuredCategory === "resource_not_found")
    && (isSessionMethod(context.method) || structuredCategory === "session_not_found")
  ) {
    return {
      code: "acp_session_not_found",
      providerSignal: structuredCategory,
    };
  }

  if (structuredCategory === "method_not_found") {
    return {
      code: "acp_method_not_found",
      providerSignal: structuredCategory,
    };
  }

  if (structuredCategory === "request_cancelled" || structuredCategory === "cancelled") {
    return {
      code: "acp_request_cancelled",
      providerSignal: structuredCategory,
    };
  }

  return undefined;
}

function classifyOpenCodeError(
  context: ProviderErrorContext,
): ProviderErrorClassification | undefined {
  if (
    context.error.code !== OPENCODE_INVALID_PARAMS_ERROR_CODE
    || !isSessionMethod(context.method)
    || !hasSessionIdentifier(context.error.data)
  ) {
    if (
      context.error.code === OPENCODE_INVALID_PARAMS_ERROR_CODE
      && isSessionMethod(context.method)
      && !hasSessionIdentifier(context.error.data)
    ) {
      log.warn("[AcpBackend] OpenCode session error lacked a structured session identifier", {
        provider: context.provider,
        method: context.method,
        rpcCode: context.error.code,
      });
    }
    return undefined;
  }

  return {
    code: "acp_session_not_found",
    providerSignal: "opencode_session_id",
  };
}

function getStructuredCategory(data: unknown): string | undefined {
  if (!isRecord(data)) {
    return undefined;
  }

  for (const key of STRUCTURED_CATEGORY_KEYS) {
    const value = data[key];
    if (typeof value === "string") {
      return normalizeCategory(value);
    }
  }

  const nestedError = data["error"];
  if (isRecord(nestedError)) {
    for (const key of STRUCTURED_CATEGORY_KEYS) {
      const value = nestedError[key];
      if (typeof value === "string") {
        return normalizeCategory(value);
      }
    }
  }

  return undefined;
}

function hasSessionIdentifier(data: unknown): boolean {
  if (!isRecord(data)) {
    return false;
  }
  return SESSION_IDENTIFIER_KEYS.some((key) => typeof data[key] === "string" && data[key].length > 0);
}

function isSessionMethod(method: string): boolean {
  return SESSION_REFERENCING_METHODS.has(method);
}

function normalizeCategory(value: string): string {
  return value.trim().toLowerCase().replaceAll("-", "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
