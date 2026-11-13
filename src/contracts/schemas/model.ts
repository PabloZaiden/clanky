/**
 * Zod schemas for model-related types.
 *
 * These schemas validate model-related API request fields. The reusable
 * domain types are owned by `src/shared/model.ts`.
 *
 * @module contracts/schemas/model
 */

import { z } from "zod";

/**
 * Schema for ModelConfig - AI model configuration.
 *
 * The schema is the runtime validator for the shared ModelConfig domain type.
 * - providerID: Required non-empty string (e.g., "anthropic", "openai", "bedrock")
 * - modelID: Required non-empty string (e.g., "claude-sonnet-4-20250514", "gpt-4o")
 * - variant: Required string (e.g., "thinking", ""). Use an empty string for the default.
 */
export const ModelConfigSchema = z.object({
  providerID: z.string().min(1, "providerID is required and must be a non-empty string"),
  modelID: z.string().min(1, "modelID is required and must be a non-empty string"),
  variant: z.string(),
});

/**
 * Re-export the shared domain types for contract consumers that need both
 * validators and the corresponding type names.
 */
export type { ModelConfig } from "@/shared/model";
