/**
 * Centralized typed helper for invoking optional ACP methods.
 *
 * Only a protocol `acp_method_not_found` is treated as capability absence.
 * Every other failure (timeout, cancellation, session-not-found, process,
 * authentication, ...) propagates unchanged so callers never mistake an
 * unrelated failure for an unsupported capability.
 */

import { isAcpErrorCode } from "./errors";
import type { OptionalMethodOutcome, RpcRequester } from "./contracts";

/**
 * Invoke a single optional method, returning a typed outcome instead of
 * throwing when the provider reports the method is not found.
 */
export async function invokeOptionalMethod<T>(
  requester: RpcRequester,
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
): Promise<OptionalMethodOutcome<T>> {
  try {
    const value = await requester.sendRequest<T>(method, params, timeoutMs);
    return { kind: "supported", value };
  } catch (error) {
    if (isAcpErrorCode(error, "acp_method_not_found")) {
      return { kind: "method-not-found" };
    }
    throw error;
  }
}
