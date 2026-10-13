/**
 * Wire-size admission, independent of the API's content-page byte budget.
 */
import { isReadRecord, readBytes } from "./resource-read-service";

export const LIVE_MAX_PARALLEL_TOOLS = 8;
export const LIVE_TOOL_ITEM_BYTES = 3500;
export const LIVE_TOOL_BATCH_BYTES = LIVE_MAX_PARALLEL_TOOLS * LIVE_TOOL_ITEM_BYTES;
export const LIVE_READ_BYTES = 1200;

export function liveToolOutput(callId: string, result: unknown, maxBytes = LIVE_TOOL_ITEM_BYTES): {
  event: Record<string, unknown>; bytes: number; reduced: boolean;
} {
  const eventId = crypto.randomUUID();
  const make = (output: unknown): Record<string, unknown> => ({
    type: "response.item.create", event_id: eventId,
    item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) ?? "null" },
  });
  let event = make(result);
  if (readBytes(event) <= maxBytes) return { event, bytes: readBytes(event), reduced: false };
  const outcome = isReadRecord(result) ? result : {};
  event = make({
    ...Object.fromEntries(["ok", "status", "completion", "operationId", "code", "requestId", "expiresAt", "reference"]
      .filter((key) => outcome[key] !== undefined && readBytes(outcome[key]) <= 700)
      .map((key) => [key, outcome[key]])),
    resultCode: "voice_result_requires_targeted_read",
    dataAvailable: false,
    message: "The result data exceeds the Live wire budget. Preserve the reported outcome. Do not repeat a mutation. Read its target with a smaller page or targeted section.",
  });
  if (readBytes(event) > maxBytes) {
    event = make({
      ...Object.fromEntries(["ok", "status", "completion", "operationId"]
        .filter((key) => outcome[key] !== undefined && readBytes(outcome[key]) <= 500)
        .map((key) => [key, outcome[key]])),
      resultCode: "voice_result_requires_targeted_read", dataAvailable: false,
      message: "Result data was not delivered. Inspect the target. Do not repeat a mutation.",
    });
  }
  return { event, bytes: readBytes(event), reduced: true };
}
