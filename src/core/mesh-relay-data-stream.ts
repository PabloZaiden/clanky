/**
 * Ticketed Mesh relay data stream.
 *
 * A data stream is one logical Mesh request or socket. It is dialled with a
 * broker-issued ticket, consumes the `stream.ready` handshake frame, and then
 * carries opaque text and binary frames that the relay forwards byte for
 * byte. Everything the stream owns — timers, listeners, and the physical
 * socket — is released exactly once by `dispose()`.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import { MeshRelayStreamReadyFrameSchema } from "@/contracts/schemas/mesh-relay";
import { MESH_RELAY_STREAM_PATH } from "@/shared/mesh-relay";
import {
  fromMeshRelayCloseCode,
  openMeshRelayClientSocket,
  toMeshRelayCloseCode,
  toMeshRelayCloseReason,
  type MeshRelayClientSocket,
  type MeshRelayClientSocketFactory,
} from "./mesh-relay-client-socket";
import { MeshRelayStreamError } from "./mesh-relay-errors";
import {
  MESH_RELAY_MAX_QUEUED_BYTES,
  MESH_RELAY_MAX_STREAM_FRAME_BYTES,
  MESH_RELAY_STREAM_CLOSE_TIMEOUT,
} from "./mesh-relay-policy";

const log = createLogger("core:mesh-relay-data-stream");

export const MESH_RELAY_DATA_OPEN_TIMEOUT_MS = 15_000;
export const MESH_RELAY_BODY_CHUNK_BYTES = 64 * 1_024;
export const MESH_RELAY_SEND_HIGH_WATER_BYTES = 1_024 * 1_024;
const DRAIN_POLL_INTERVAL_MS = 5;
const DRAIN_TIMEOUT_MS = 60_000;
const FLUSH_TIMEOUT_MS = 30_000;
/** Bound the frames buffered for a consumer that has not read them yet. */
const MAX_QUEUED_ITEMS = 256;

export type MeshRelayStreamItem =
  | { kind: "text"; text: string }
  | { kind: "binary"; bytes: Uint8Array }
  | { kind: "closed"; code: number; reason: string };

interface PendingRead {
  resolve(item: MeshRelayStreamItem): void;
  reject(error: unknown): void;
  timer?: ReturnType<typeof setTimeout>;
}

function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return undefined;
}

export class MeshRelayDataStream {
  private readonly queue: MeshRelayStreamItem[] = [];
  private queuedBytes = 0;
  private pendingRead?: PendingRead;
  private closedItem?: MeshRelayStreamItem & { kind: "closed" };
  private closeRequested = false;
  private disposed = false;
  private readonly closedPromise: Promise<
    MeshRelayStreamItem & { kind: "closed" }
  >;
  private resolveClosed!: (
    item: MeshRelayStreamItem & { kind: "closed" },
  ) => void;

  constructor(
    private readonly socket: MeshRelayClientSocket,
    readonly requestId: string,
    readonly streamId: string,
    private readonly detach: () => void,
  ) {
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  get closed(): boolean {
    return this.closedItem !== undefined
      || this.socket.readyState > 1;
  }

  /** Accept a frame forwarded by the relay. */
  push(item: MeshRelayStreamItem): void {
    if (item.kind === "closed") {
      if (this.closedItem) {
        return;
      }
      this.closedItem = item;
      this.resolveClosed(item);
    }
    const pending = this.pendingRead;
    if (pending) {
      this.pendingRead = undefined;
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.resolve(item);
      return;
    }
    if (this.queue.length >= MAX_QUEUED_ITEMS && item.kind !== "closed") {
      log.warn("Dropping Mesh relay stream frame past the queue limit", {
        streamId: this.streamId,
      });
      this.close(1009, "Mesh relay stream queue overflow");
      return;
    }
    const itemBytes = item.kind === "text"
      ? Buffer.byteLength(item.text, "utf8")
      : item.kind === "binary"
        ? item.bytes.byteLength
        : 0;
    if (
      item.kind !== "closed"
      && this.queuedBytes + itemBytes > MESH_RELAY_MAX_QUEUED_BYTES
    ) {
      log.warn("Closing Mesh relay stream past the queued byte limit", {
        streamId: this.streamId,
      });
      this.close(1009, "Mesh relay stream queue overflow");
      return;
    }
    this.queue.push(item);
    this.queuedBytes += itemBytes;
  }

  /** Observe closure without consuming a queued data frame. */
  async waitUntilClosed(): Promise<MeshRelayStreamItem & { kind: "closed" }> {
    return await this.closedPromise;
  }

  /** Read the next frame, or the terminal close item. */
  async next(timeoutMs?: number): Promise<MeshRelayStreamItem> {
    const queued = this.queue.shift();
    if (queued) {
      this.queuedBytes -= queued.kind === "text"
        ? Buffer.byteLength(queued.text, "utf8")
        : queued.kind === "binary"
          ? queued.bytes.byteLength
          : 0;
      return queued;
    }
    if (this.closedItem) {
      return this.closedItem;
    }
    if (this.pendingRead) {
      throw new MeshRelayStreamError(
        "mesh_relay_stream_read_conflict",
        "The Mesh relay stream already has a pending read.",
      );
    }
    return await new Promise<MeshRelayStreamItem>((resolve, reject) => {
      const pending: PendingRead = { resolve, reject };
      if (timeoutMs !== undefined) {
        pending.timer = setTimeout(() => {
          if (this.pendingRead !== pending) {
            return;
          }
          this.pendingRead = undefined;
          this.close(
            MESH_RELAY_STREAM_CLOSE_TIMEOUT,
            "Mesh relay stream timed out",
          );
          reject(new MeshRelayStreamError(
            "mesh_relay_stream_timeout",
            "The Mesh relay stream timed out waiting for a frame.",
            { status: 504 },
          ));
        }, timeoutMs);
        pending.timer.unref?.();
      }
      this.pendingRead = pending;
    });
  }

  send(data: string | Uint8Array): void {
    if (this.closed) {
      throw new MeshRelayStreamError(
        "mesh_relay_stream_closed",
        "The Mesh relay stream is closed.",
      );
    }
    const bytes = typeof data === "string"
      ? Buffer.byteLength(data, "utf8")
      : data.byteLength;
    if (bytes > MESH_RELAY_MAX_STREAM_FRAME_BYTES) {
      throw new MeshRelayStreamError(
        "mesh_relay_frame_too_large",
        "The Mesh relay frame exceeds the transport limit.",
        { status: 413 },
      );
    }
    this.socket.send(data);
  }

  /** Send binary payloads split into relay-sized chunks, honouring backpressure. */
  async sendBinaryChunks(bytes: Uint8Array): Promise<void> {
    for (let offset = 0; offset < bytes.byteLength; offset += MESH_RELAY_BODY_CHUNK_BYTES) {
      await this.waitForDrain();
      this.send(bytes.subarray(offset, offset + MESH_RELAY_BODY_CHUNK_BYTES));
    }
  }

  /**
   * Wait until the socket send buffer drops below the relay backpressure
   * limit. WebSocket has no drain event, so this polls the buffer size.
   */
  async waitForDrain(): Promise<void> {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (
      !this.closed
      && this.socket.bufferedAmount > Math.min(
        MESH_RELAY_SEND_HIGH_WATER_BYTES,
        MESH_RELAY_MAX_QUEUED_BYTES,
      )
    ) {
      if (Date.now() > deadline) {
        this.close(1013, "Mesh relay stream backpressure timeout");
        throw new MeshRelayStreamError(
          "mesh_relay_stream_backpressure",
          "The Mesh relay stream stayed blocked by backpressure.",
          { status: 504 },
        );
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, DRAIN_POLL_INTERVAL_MS);
        timer.unref?.();
      });
    }
  }

  close(code?: number, reason?: string): void {
    if (this.closeRequested) {
      return;
    }
    this.closeRequested = true;
    const closeSocket = (): void => {
      if (this.socket.readyState > 1) {
        return;
      }
      try {
        this.socket.close(toMeshRelayCloseCode(code), toMeshRelayCloseReason(reason));
      } catch (error) {
        log.debug("Mesh relay stream close was rejected by the socket", {
          streamId: this.streamId,
          error: String(error),
        });
      }
    };
    // Closing a WebSocket discards frames that are still buffered, so the
    // send buffer is drained first while the local side is already closed.
    if (this.socket.readyState === 1 && this.socket.bufferedAmount > 0) {
      void this.flush().finally(closeSocket);
    } else {
      closeSocket();
    }
    this.push({
      kind: "closed",
      code: code ?? 1000,
      reason: reason ?? "Mesh relay stream closed",
    });
  }

  /** Wait until every queued frame has been handed to the transport. */
  async flush(timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.socket.readyState === 1 && this.socket.bufferedAmount > 0) {
      if (Date.now() > deadline) {
        log.warn("A Mesh relay stream did not flush before closing", {
          streamId: this.streamId,
        });
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, DRAIN_POLL_INTERVAL_MS);
        timer.unref?.();
      });
    }
  }

  /** Release listeners and reject any pending read exactly once. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.detach();
    if (!this.closedItem) {
      this.closedItem = {
        kind: "closed",
        code: 1000,
        reason: "Mesh relay stream disposed",
      };
      this.resolveClosed(this.closedItem);
    }
    const pending = this.pendingRead;
    this.pendingRead = undefined;
    if (pending?.timer) {
      clearTimeout(pending.timer);
    }
    pending?.resolve(this.closedItem);
    this.queue.length = 0;
    this.queuedBytes = 0;
  }
}

export interface OpenMeshRelayDataStreamOptions {
  relayUrl: string;
  ticket: string;
  credential: string;
  requestId: string;
  streamId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  socketFactory?: MeshRelayClientSocketFactory;
}

function buildStreamUrl(relayUrl: string, ticket: string, credential: string): string {
  const base = new URL(relayUrl);
  base.protocol = base.protocol === "http:" ? "ws:" : "wss:";
  const url = new URL(MESH_RELAY_STREAM_PATH, base);
  url.searchParams.set("ticket", ticket);
  url.searchParams.set("credential", credential);
  return url.toString();
}

/**
 * Dial one side of a ticketed relay stream and consume `stream.ready`.
 */
export async function openMeshRelayDataStream(
  options: OpenMeshRelayDataStreamOptions,
): Promise<MeshRelayDataStream> {
  const factory = options.socketFactory ?? openMeshRelayClientSocket;
  const socket = factory(
    buildStreamUrl(options.relayUrl, options.ticket, options.credential),
  );
  socket.binaryType = "arraybuffer";

  let stream: MeshRelayDataStream | undefined;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onMessage = (event: MessageEvent): void => {
    if (stream) {
      const bytes = toBytes(event.data);
      stream.push(bytes
        ? { kind: "binary", bytes }
        : { kind: "text", text: String(event.data) });
      return;
    }
    handshake(event);
  };
  const onClose = (event: CloseEvent): void => {
    const code = fromMeshRelayCloseCode(event.code);
    if (stream) {
      stream.push({ kind: "closed", code, reason: event.reason });
      return;
    }
    fail(new MeshRelayStreamError(
      code === 4_401 || code === 4_410
        ? "mesh_relay_stream_ticket_rejected"
        : "mesh_relay_stream_unavailable",
      event.reason.trim() || "The Mesh relay stream closed before it was ready.",
      { status: 503 },
    ));
  };
  const onError = (): void => {
    if (stream) {
      stream.push({
        kind: "closed",
        code: 1006,
        reason: "Mesh relay stream failed",
      });
      return;
    }
    fail(new MeshRelayStreamError(
      "mesh_relay_stream_unavailable",
      "The Mesh relay stream could not be opened.",
      { status: 503 },
    ));
  };

  const detach = (): void => {
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("close", onClose);
    socket.removeEventListener("error", onError);
    options.signal?.removeEventListener("abort", onAbort);
  };

  let resolveStream!: (value: MeshRelayDataStream) => void;
  let rejectStream!: (error: unknown) => void;
  const ready = new Promise<MeshRelayDataStream>((resolve, reject) => {
    resolveStream = resolve;
    rejectStream = reject;
  });

  function finish(value: MeshRelayDataStream): void {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolveStream(value);
  }

  function fail(error: unknown): void {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    detach();
    if (socket.readyState <= 1) {
      socket.close(4_400, "Mesh relay stream handshake failed");
    }
    rejectStream(error);
  }

  const onAbort = (): void => {
    fail(new MeshRelayStreamError(
      "mesh_relay_request_aborted",
      "The Mesh relay request was aborted.",
      { status: 499 },
    ));
  };

  function handshake(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      fail(new MeshRelayStreamError(
        "mesh_relay_stream_handshake_invalid",
        "The Mesh relay stream handshake frame must be text.",
      ));
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch (error) {
      fail(new MeshRelayStreamError(
        "mesh_relay_stream_handshake_invalid",
        "The Mesh relay stream handshake frame is malformed.",
        { cause: error },
      ));
      return;
    }
    const result = MeshRelayStreamReadyFrameSchema.safeParse(parsed);
    if (
      !result.success
      || result.data.streamId !== options.streamId
      || result.data.requestId !== options.requestId
    ) {
      fail(new MeshRelayStreamError(
        "mesh_relay_stream_handshake_invalid",
        "The Mesh relay stream handshake does not match the issued ticket.",
      ));
      return;
    }
    stream = new MeshRelayDataStream(
      socket,
      options.requestId,
      options.streamId,
      detach,
    );
    finish(stream);
  }

  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  socket.addEventListener("error", onError);
  if (options.signal?.aborted) {
    onAbort();
    return await ready;
  }
  options.signal?.addEventListener("abort", onAbort, { once: true });
  timer = setTimeout(() => {
    fail(new MeshRelayStreamError(
      "mesh_relay_stream_open_timeout",
      "The Mesh relay stream did not become ready in time.",
      { status: 504 },
    ));
  }, options.timeoutMs ?? MESH_RELAY_DATA_OPEN_TIMEOUT_MS);
  timer.unref?.();

  return await ready;
}
