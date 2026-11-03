import { DomainError } from "../domain/domain-error";
import { EventStreamOverflowError } from "../utils/event-stream";
import { HarnessError } from "./harness-errors";

const messages = {
  event_queue_overflow: "The native event queue overflowed.",
  event_too_large: "A native event exceeded the stream size limit.",
  native_source_failed: "The native runtime's event source failed.",
  native_translation_failed: "A native runtime event could not be translated.",
  tool_start_missing: "A native tool completed without its observed start.",
  event_frame_incomplete: "The native event stream ended with an incomplete frame.",
  event_frame_too_large: "The native event stream exceeded its frame size limit.",
  event_frame_invalid: "The native event stream contained an invalid frame.",
  event_sequence_gap: "The native event stream skipped or repeated a sequence number.",
  event_schema_invalid: "A native event did not match the supported event format.",
  interaction_capacity_exceeded: "The native interaction observation limit was reached.",
  control_capacity_exceeded: "The native control observation capacity was exceeded.",
  control_request_duplicate: "The native control stream repeated a request identifier.",
  transport_closed: "The native Mesh event connection was lost.",
  unknown: "Native Mesh observation is incomplete.",
} as const;

const numericFields = [
  "queuedEvents", "limitEvents", "eventBytes", "limitBytes", "frameBytes",
  "expectedSequence", "actualSequence", "sequence", "pendingOperations", "limitOperations",
] as const;
const errorTypes = [
  "Error", "TypeError", "RangeError", "SyntaxError", "ZodError", "DomainError",
  "HarnessError", "EventStreamOverflowError", "MeshRelayStreamError", "NonError",
] as const;

type ObservationReason = keyof typeof messages;
type ErrorType = typeof errorTypes[number];
type NumericDetails = Partial<Record<typeof numericFields[number], number>>;
export type HarnessObservationDetails = NumericDetails & {
  reason: ObservationReason;
  streamId?: string;
  causeTypes: ErrorType[];
};

function isReason(value: unknown): value is ObservationReason {
  return typeof value === "string" && Object.hasOwn(messages, value);
}

function errorType(error: unknown): ErrorType {
  if (!(error instanceof Error)) return "NonError";
  return errorTypes.find((type) => type === error.name) ?? "Error";
}

export function readHarnessObservationDetails(value: unknown): HarnessObservationDetails {
  const result: HarnessObservationDetails = { reason: "unknown", causeTypes: [] };
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  if ("reason" in value && isReason(value.reason)) result.reason = value.reason;
  for (const key of numericFields) {
    if (key in value) {
      const number = Reflect.get(value, key);
      if (typeof number === "number" && Number.isSafeInteger(number) && number >= 0) result[key] = number;
    }
  }
  if ("streamId" in value && typeof value.streamId === "string" && /^[a-z0-9]{1,8}$/.test(value.streamId)) {
    result.streamId = value.streamId;
  }
  if ("causeTypes" in value && Array.isArray(value.causeTypes)) {
    result.causeTypes = value.causeTypes.slice(0, 4).flatMap((entry) => {
      const type = errorTypes.find((candidate) => candidate === entry);
      return type ? [type] : [];
    });
  }
  return result;
}

export function getHarnessObservationDetails(error: unknown): HarnessObservationDetails {
  const result: HarnessObservationDetails = { reason: "unknown", causeTypes: [] };
  const seen = new Set<unknown>();
  for (let current = error; !seen.has(current) && seen.size < 4; ) {
    seen.add(current);
    result.causeTypes.push(errorType(current));
    if (current instanceof EventStreamOverflowError) {
      Object.assign(result, readHarnessObservationDetails(current), {
        reason: "event_queue_overflow", causeTypes: result.causeTypes,
      });
    }
    if (current instanceof DomainError) {
      const details = readHarnessObservationDetails(current.details);
      if (current.code === "harness_transport_closed") details.reason = "transport_closed";
      const causes = [...result.causeTypes, ...details.causeTypes].slice(0, 4);
      Object.assign(result, details, { causeTypes: causes, reason: details.reason === "unknown" ? result.reason : details.reason });
    }
    if (!(current instanceof Error) || current.cause === undefined) break;
    current = current.cause;
  }
  result.causeTypes = result.causeTypes.slice(0, 4);
  return result;
}

export function getHarnessObservationFailure(error: unknown): {
  code: "harness_event_gap" | "harness_transport_closed";
  message: string;
  details: HarnessObservationDetails;
} {
  const details = getHarnessObservationDetails(error);
  const code = error instanceof DomainError && error.code === "harness_transport_closed"
    ? "harness_transport_closed" : "harness_event_gap";
  if (code === "harness_transport_closed") details.reason = "transport_closed";
  let message: string = messages[details.reason];
  if (details.reason === "event_queue_overflow" && details.queuedEvents !== undefined && details.limitEvents !== undefined) {
    message += ` Queued events: ${details.queuedEvents}; capacity: ${details.limitEvents}.`;
  } else if (details.reason === "event_too_large" && details.eventBytes !== undefined && details.limitBytes !== undefined) {
    message += ` Event bytes: ${details.eventBytes}; limit: ${details.limitBytes}.`;
  }
  return { code, message: `${message} Reconnect to recover the conversation.`, details };
}

export function createHarnessObservationError(reason: ObservationReason, details: NumericDetails = {}, cause?: unknown): HarnessError {
  return new HarnessError(
    reason === "transport_closed" ? "harness_transport_closed" : "harness_event_gap",
    messages[reason],
    { details: { ...details, reason }, ...(cause !== undefined ? { cause } : {}) },
  );
}
