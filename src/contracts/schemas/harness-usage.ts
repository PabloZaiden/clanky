/**
 * Validated native consumption snapshots and persisted entity summaries.
 */

import { z } from "zod";

const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const TokenCountsSchema = z.object({
  inputTokens: Count.optional(),
  outputTokens: Count.optional(),
  reasoningTokens: Count.optional(),
  cacheReadTokens: Count.optional(),
  cacheWriteTokens: Count.optional(),
});

export const HarnessUsageSnapshotSchema = z.object({
  observedAt: z.iso.datetime(),
  coverage: z.enum(["complete", "partial"]),
  contributors: z.array(z.object({
    id: z.string().min(1).max(1000),
    tokens: TokenCountsSchema,
  })).max(1000),
}).superRefine((snapshot, ctx) => {
  if (new Set(snapshot.contributors.map((entry) => entry.id)).size !== snapshot.contributors.length) {
    ctx.addIssue({ code: "custom", message: "Usage contributors must be disjoint." });
  }
});

export const TokenUsageSummarySchema = TokenCountsSchema.extend({
  observedAt: z.iso.datetime(),
  coverage: z.enum(["complete", "partial"]),
  status: z.enum(["current", "stale"]),
});
