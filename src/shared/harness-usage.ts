/**
 * Cumulative consumption, never context-window occupancy or billing estimates.
 */

export const TOKEN_USAGE_FIELDS = [
  "inputTokens", "outputTokens", "reasoningTokens", "cacheReadTokens", "cacheWriteTokens",
] as const;

export type TokenCounts = Partial<Record<typeof TOKEN_USAGE_FIELDS[number], number>>;

export interface HarnessUsageSnapshot {
  observedAt: string;
  coverage: "complete" | "partial";
  /** Disjoint cumulative counters. A provider-wide total is one contributor. */
  contributors: Array<{ id: string; tokens: TokenCounts }>;
}

export interface TokenUsageSummary extends TokenCounts {
  observedAt: string;
  coverage: "complete" | "partial";
  status: "current" | "stale";
}
