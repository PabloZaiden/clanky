import type { CollaborationActor } from "./collaboration";
import type { HarnessConversationBinding } from "./harness-control";
import type { ModelConfig } from "./model";
import { isReadRecord } from "./record";

export interface ProviderLimit {
  kind: "quota" | "rate_limit" | "billing";
  retryAt?: string;
}

export interface ProviderContinuation {
  status: "scheduled" | "attempting" | "paused";
  attempts: number;
  nextAttemptAt?: string;
  reason?: string;
  conversation: HarnessConversationBinding;
  model: ModelConfig;
  actor: CollaborationActor;
}

export interface ChatProviderLimit extends ProviderLimit {
  id: string;
  continuation?: ProviderContinuation;
}

export const MAX_PROVIDER_CONTINUATION_ATTEMPTS = 12;

export function providerLimitCode(kind: ProviderLimit["kind"]): string {
  return kind === "quota" ? "harness_quota_exceeded"
    : kind === "rate_limit" ? "harness_rate_limited" : "harness_billing_required";
}

export function readProviderLimit(code: string | undefined, details?: Readonly<Record<string, unknown>>): ProviderLimit | undefined {
  const kind = code === "harness_quota_exceeded" ? "quota"
    : code === "harness_rate_limited" ? "rate_limit"
      : code === "harness_billing_required" ? "billing" : undefined;
  if (!kind) return undefined;
  const value = details?.["providerLimit"];
  const retryAt = isReadRecord(value) ? value["retryAt"] : undefined;
  return {
    kind,
    ...(typeof retryAt === "string" && /^\d{4}-/.test(retryAt) && Number.isFinite(Date.parse(retryAt))
      ? { retryAt: new Date(retryAt).toISOString() } : {}),
  };
}

export function nextProviderContinuationAt(limit: ProviderLimit, attempts: number, now = Date.now()): string {
  const reset = limit.retryAt ? Date.parse(limit.retryAt) : NaN;
  if (Number.isFinite(reset) && (reset > now || attempts === 0)) {
    return new Date(Math.max(now, reset)).toISOString();
  }
  const minutes = [1, 5, 15, 30][Math.min(attempts, 3)]!;
  return new Date(now + minutes * 60_000).toISOString();
}

export function providerLimitLabel(limit: ProviderLimit): string {
  return limit.kind === "quota" ? "Quota exhausted"
    : limit.kind === "rate_limit" ? "Rate limited" : "Billing action required";
}
