import { z } from "zod";
import { HARNESS_ADAPTER_IDS } from "@/shared/harness-events";
import { HARNESS_DIAGNOSTIC_ERROR_TYPES, HARNESS_NATIVE_ERROR_CODES } from "@/shared/harness-diagnostics";

export const HarnessDiagnosticCodeSchema = z.string().max(96).regex(
  /^(?:(?:harness|mesh|control)_[a-z0-9_]+|E[A-Z_]{2,30}|authentication_error|invalid_request_error|permission_error|not_found_error|rate_limit_error|overloaded_error|api_error|context_length_exceeded|insufficient_quota|billing_not_configured)$/,
);
const Method = z.string().max(80).regex(/^[a-z][a-zA-Z0-9]*(?:[./_-][a-zA-Z][a-zA-Z0-9]*)*$/);
export const HarnessDiagnosticSchema = z.object({
  id: z.string().uuid(),
  timestamp: z.iso.datetime().max(32),
  adapter: z.enum(HARNESS_ADAPTER_IDS).optional(),
  operation: Method,
  causes: z.array(z.object({
    type: z.enum(HARNESS_DIAGNOSTIC_ERROR_TYPES),
    code: HarnessDiagnosticCodeSchema.optional(),
    nativeCode: z.enum(HARNESS_NATIVE_ERROR_CODES).optional(),
    rpcCode: z.number().int().safe().optional(),
    status: z.number().int().min(100).max(599).optional(),
    method: Method.optional(),
    frames: z.array(z.string().max(120).regex(/^[a-zA-Z0-9_-]+(?:\.[cm]?[jt]sx?)?:[0-9]+(?::[0-9]+)?$/)).max(6),
  })).max(4),
});
