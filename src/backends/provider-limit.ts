import type { ProviderLimit } from "@/shared/provider-limit";
import { providerLimitCode } from "@/shared/provider-limit";

export function providerFailure(limit?: ProviderLimit): { code: string; details?: { providerLimit: ProviderLimit } } {
  return limit
    ? { code: providerLimitCode(limit.kind), details: { providerLimit: limit } }
    : { code: "harness_request_failed" };
}

export function providerRetryAt(milliseconds: number | undefined): string | undefined {
  return milliseconds !== undefined && Number.isFinite(milliseconds)
    && milliseconds >= 0 && milliseconds < Date.UTC(10_000, 0, 1)
    ? new Date(milliseconds).toISOString() : undefined;
}
