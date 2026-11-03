/**
 * Bounded native observation frames with demand-aware keepalives.
 */
import { createLogger } from "@pablozaiden/webapp/server";
import { HarnessError } from "../../backends/harness-errors";
import { getHarnessObservationFailure } from "../../backends/harness-observation-errors";
import type { HarnessEvent } from "@/shared/harness-events";
import type { MeshExecutionProtocolVersion } from "@/shared/mesh-execution";
import type { EventStream } from "../../utils/event-stream";
import type { MeshHarnessControlEvent } from "@/contracts/schemas/mesh-harness";

const log = createLogger("api:mesh:harness-events");

export function createHarnessEventStream(options: {
  subscription: EventStream<HarnessEvent | MeshHarnessControlEvent>;
  channel?: "control";
  protocolVersion: MeshExecutionProtocolVersion;
  context: { requestId: string; leaseSessionId: string; conversationId?: string };
  signal: AbortSignal;
  onObservationClosed: () => void;
}): ReadableStream<Uint8Array> {
  let sequence = 0;
  let closed = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const enqueueFrame = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    payload: { type: "ready" | "heartbeat" | "event" | "control"; event?: HarnessEvent | MeshHarnessControlEvent },
  ): void => {
    controller.enqueue(encoder.encode(`${JSON.stringify({
      protocolVersion: options.protocolVersion,
      sequence: sequence++,
      payload,
    })}\n`));
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    options.subscription.close();
    clearInterval(heartbeat);
    options.signal.removeEventListener("abort", abort);
  };
  const abort = (): void => {
    if (closed) return;
    close();
    streamController.close();
    options.onObservationClosed();
  };

  return new ReadableStream<Uint8Array>({
    start(controller): void {
      streamController = controller;
      if (options.signal.aborted) { abort(); return; }
      options.signal.addEventListener("abort", abort, { once: true });
      enqueueFrame(controller, { type: "ready" });
      heartbeat = setInterval(() => {
        // A full response queue is backpressure, not a lost provider event.
        if (closed || (controller.desiredSize ?? 0) <= 0) return;
        enqueueFrame(controller, { type: "heartbeat" });
      }, 15_000);
      heartbeat.unref?.();
    },
    async pull(controller): Promise<void> {
      if (closed) return;
      try {
        const event = await options.subscription.next();
        if (closed) return;
        if (!event) { close(); controller.close(); return; }
        enqueueFrame(controller, { type: options.channel === "control" ? "control" : "event", event });
      } catch (error) {
        if (closed) return;
        close();
        const failure = getHarnessObservationFailure(error);
        const transportClosed = failure.code === "harness_transport_closed";
        log[transportClosed ? "warn" : "error"]("Native Mesh observation ended", {
          ...options.context,
          channel: options.channel ?? "conversation",
          lastSequence: sequence - 1,
          code: failure.code,
          ...failure.details,
        });
        if (options.channel === "control") {
          try { controller.error(new HarnessError(failure.code, failure.message, { details: failure.details })); }
          finally { options.onObservationClosed(); }
          return;
        }
        try {
          enqueueFrame(controller, {
            type: "event",
            event: {
              type: "error",
              ...failure,
              scope: { kind: "principal" },
            },
          });
          controller.close();
        } finally {
          options.onObservationClosed();
        }
      }
    },
    cancel(): void {
      if (closed) return;
      close();
      options.onObservationClosed();
    },
  }, { highWaterMark: 1 });
}
