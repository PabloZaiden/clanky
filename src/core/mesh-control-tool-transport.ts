import type { MeshHarnessControlEvent } from "@/contracts/schemas/mesh-harness";
import type { ControlToolReply } from "@/contracts/schemas/control-tool-transport";
import { MESH_CONTROL_MAX_IN_FLIGHT_REQUESTS } from "@/shared/mesh-execution";
import type { ControlToolConnection } from "./control-tool-transport";
import { DomainError } from "../domain/domain-error";
import { createEventStream, type EventStream } from "../utils/event-stream";

interface PendingControl {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  detach: () => void;
}

/** A lease's reverse requests and forward replies, independent of provider startup. */
export class MeshControlToolChannel {
  private readonly producer = createEventStream<MeshHarnessControlEvent>({ overflow: "fail", maxBufferSize: 256 });
  private readonly pending = new Map<string, PendingControl>();
  private readonly cancelled = new Set<string>();
  private closed = false;

  readonly events: EventStream<MeshHarnessControlEvent> = {
    next: () => this.producer.stream.next(),
    close: () => this.close(),
  };

  readonly connection: ControlToolConnection = {
    request: async (request, signal) => {
      if (this.closed) throw new DomainError("control_unavailable", "The execution control channel is closed.");
      signal.throwIfAborted();
      if (this.pending.size >= MESH_CONTROL_MAX_IN_FLIGHT_REQUESTS) {
        throw new DomainError("control_busy", "Too many execution control requests are pending.", { details: { notExecuted: true } });
      }
      const requestId = crypto.randomUUID();
      return await new Promise<unknown>((resolve, reject) => {
        const abort = (): void => {
          if (!this.pending.delete(requestId)) return;
          signal.removeEventListener("abort", abort);
          this.cancelled.add(requestId);
          if (this.cancelled.size > 256) this.cancelled.delete(this.cancelled.values().next().value!);
          this.producer.push({ type: "cancel", requestId });
          reject(new DomainError("control_cancelled", "The execution control request was cancelled."));
        };
        this.pending.set(requestId, { resolve, reject, detach: () => signal.removeEventListener("abort", abort) });
        signal.addEventListener("abort", abort, { once: true });
        this.producer.push({ type: "request", requestId, request });
        if (signal.aborted) abort();
      });
    },
  };

  reply(requestId: string, reply: ControlToolReply): { status: "completed" | "cancelled" } {
    const pending = this.pending.get(requestId);
    if (!pending) {
      if (this.cancelled.delete(requestId)) return { status: "cancelled" };
      throw new DomainError("control_request_unavailable", "The control reply does not belong to a pending execution request.");
    }
    this.pending.delete(requestId);
    pending.detach();
    if (reply.ok) pending.resolve(reply.result);
    else pending.reject(new DomainError(reply.error.code, reply.error.message, {
      details: { notExecuted: reply.completion === "not_executed" },
    }));
    return { status: "completed" };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.producer.end();
    for (const pending of this.pending.values()) {
      pending.detach();
      pending.reject(new DomainError("control_unavailable", "The execution control channel ended without an authoritative result."));
    }
    this.pending.clear();
    this.cancelled.clear();
  }
}
