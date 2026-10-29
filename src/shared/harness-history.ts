/**
 * Bounded, read-only recovery of completed native principal content.
 */
import type { HarnessEvent } from "./harness-events";

export const HARNESS_HISTORY_MAX_NATIVE_EVENTS = 100_000;
export const HARNESS_HISTORY_MAX_NATIVE_BYTES = 128 * 1024 * 1024;
export const HARNESS_HISTORY_MAX_EVENTS = 2_000;
export const HARNESS_HISTORY_MAX_BYTES = 2 * 1024 * 1024;

export type HarnessHistoryEvent = Extract<HarnessEvent, { type: "message.start" | "message.complete" | "tool.start" | "tool.complete" }>;

/** No historical user inputs, interactions, deltas, or prompt completion signals. */
export interface HarnessSessionHistory<TEvent extends HarnessEvent = HarnessHistoryEvent> {
  events: TEvent[];
  /** Current native execution state, not inferred from persisted idle events. */
  principalProcessing: boolean;
  /** Opaque, single-use continuation owned by this backend and session. */
  nextCursor?: string;
}
