import type { HarnessAdapter } from "./harness-events";

export const HARNESS_DIAGNOSTIC_ERROR_TYPES = [
  "Error", "TypeError", "RangeError", "SyntaxError", "AggregateError", "ZodError",
  "DomainError", "HarnessError", "AbortError", "TimeoutError", "NonError",
] as const;

export const HARNESS_NATIVE_ERROR_CODES = [
  "usageLimitExceeded", "rateLimitExceeded", "contextWindowExceeded", "serverOverloaded",
  "sessionBudgetExceeded", "flexUnavailable", "cyberPolicy", "misalignmentPolicyViolation", "tooManyDenials",
  "httpConnectionFailed", "responseStreamConnectionFailed", "responseStreamDisconnected", "responseTooManyFailedAttempts",
  "internalServerError", "threadRollbackFailed", "sandboxError", "activeTurnNotSteerable", "unauthorized", "badRequest", "other",
  "quota_exceeded", "session_quota_exceeded", "user_weekly_rate_limited", "billing_not_configured",
  "authentication_failed", "authentication_error", "billing_error", "rate_limit", "quota", "query",
  "invalid_request", "invalid_request_error", "server_error", "max_output_tokens", "unknown",
  "error_during_execution", "error_max_turns", "error_max_budget_usd", "error_max_structured_output_retries",
  "insufficient_quota", "credit_balance_exhausted", "usage_limit_exceeded", "rate_limit_exceeded",
  "rate_limit_error", "overloaded_error", "context_length_exceeded", "permission_error", "not_found_error", "api_error",
] as const;

export interface HarnessDiagnostic {
  id: string;
  timestamp: string;
  adapter?: HarnessAdapter;
  operation: string;
  causes: Array<{
    type: typeof HARNESS_DIAGNOSTIC_ERROR_TYPES[number];
    code?: string;
    nativeCode?: typeof HARNESS_NATIVE_ERROR_CODES[number];
    rpcCode?: number;
    status?: number;
    method?: string;
    frames: string[];
  }>;
}
