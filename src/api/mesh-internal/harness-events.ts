/**
 * Bounded native observation frames with demand-aware keepalives.
 */
import { createLogger } from "@pablozaiden/webapp/server";
import { encryptMeshPayload } from "../../core/mesh-payload-crypto";
import { isDomainError } from "../../domain/domain-error";
import type { HarnessEvent } from "@/shared/harness-events";
import type { MeshExecutionProtocolVersion } from "@/shared/mesh-execution";
import type { EventStream } from "../../utils/event-stream";

const log = createLogger("api:mesh:harness-events");

export function createHarnessEventStream(options: {
  subscription: EventStream<HarnessEvent>;
  encryptionKey: string;
  protocolVersion: MeshExecutionProtocolVersion;
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
    payload: { type: "ready" | "heartbeat" | "event"; event?: HarnessEvent },
  ): void => {
    controller.enqueue(encoder.encode(`${JSON.stringify({
      protocolVersion: options.protocolVersion,
      sequence: sequence++,
      encryptedPayload: encryptMeshPayload(payload, options.encryptionKey),
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
        enqueueFrame(controller, { type: "event", event });
      } catch (error) {
        if (closed) return;
        close();
        const transportClosed = isDomainError(error) && error.code === "harness_transport_closed";
        const code = transportClosed ? "harness_transport_closed" : "harness_event_gap";
        log[transportClosed ? "warn" : "error"]("Native Mesh observation ended", {
          code,
          errorType: error instanceof Error ? error.name : "unknown",
        });
        try {
          enqueueFrame(controller, {
            type: "event",
            event: {
              type: "error",
              code,
              message: transportClosed
                ? "The native Mesh event connection was lost."
                : "Native Mesh observation is incomplete. Reconnect to recover the conversation.",
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
