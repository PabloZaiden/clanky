/**
 * Paginated, read-only recovery of completed native principal content.
 */
import type { HarnessEvent } from "./harness-events";

export type HarnessHistoryEvent = Extract<HarnessEvent, { type: "message.start" | "message.complete" | "tool.start" | "tool.complete" }>;

/** No historical user inputs, interactions, deltas, or prompt completion signals. */
export interface HarnessSessionHistory<TEvent extends HarnessEvent = HarnessHistoryEvent> {
  events: TEvent[];
  /** Current native execution state, not inferred from persisted idle events. */
  principalProcessing: boolean;
  /** Opaque, single-use continuation owned by this backend and session. */
  nextCursor?: string;
}
