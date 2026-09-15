/**
 * WebSocket-shaped virtual client for Mesh relay socket streams.
 *
 * Existing ACP, terminal and TCP tunnel consumers treat their Mesh transport
 * as a `WebSocket`, so this class reproduces the observable surface they use:
 * numeric `readyState`, `binaryType`, `on*` handlers, `addEventListener`, and
 * `send`/`close` semantics. Message boundaries are preserved: text frames stay
 * text and binary frames stay binary.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import type { MeshDuplexSocket } from "./mesh-peer-transport";
import type { MeshRelayDataStream } from "./mesh-relay-data-stream";

const log = createLogger("core:mesh-relay-socket");

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

export const MESH_RELAY_SOCKET_QUEUE_MAX_MESSAGES = 64;
export const MESH_RELAY_SOCKET_QUEUE_MAX_BYTES = 1_024 * 1_024;

function toUint8Array(data: ArrayBufferLike | ArrayBufferView): Uint8Array {
  return ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
}

export class MeshRelayDuplexSocket extends EventTarget implements MeshDuplexSocket {
  binaryType: BinaryType = "arraybuffer";
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  private state: number = CONNECTING;
  private stream?: MeshRelayDataStream;
  private readonly queue: (string | Uint8Array)[] = [];
  private queuedBytes = 0;
  private closeRequested?: { code: number; reason: string };
  private closeDispatched = false;
  private readonly openController = new AbortController();

  constructor(open: (signal: AbortSignal) => Promise<MeshRelayDataStream>) {
    super();
    void this.start(open);
  }

  get readyState(): number {
    return this.state;
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.state === CLOSING || this.state === CLOSED) {
      return;
    }
    if (data instanceof Blob) {
      void data.arrayBuffer()
        .then((buffer) => this.send(buffer))
        .catch((error: unknown) => {
          log.warn("A Mesh relay socket blob could not be read", {
            error: String(error),
          });
          this.fail("The Mesh relay socket payload could not be read.");
        });
      return;
    }
    const payload = typeof data === "string" ? data : toUint8Array(data);
    if (this.state === OPEN && this.stream) {
      this.stream.send(payload);
      return;
    }
    const bytes = typeof payload === "string"
      ? Buffer.byteLength(payload, "utf8")
      : payload.byteLength;
    if (
      this.queue.length >= MESH_RELAY_SOCKET_QUEUE_MAX_MESSAGES
      || this.queuedBytes + bytes > MESH_RELAY_SOCKET_QUEUE_MAX_BYTES
    ) {
      this.fail("The Mesh relay socket send queue overflowed before it opened.");
      return;
    }
    this.queue.push(payload);
    this.queuedBytes += bytes;
  }

  close(code?: number, reason?: string): void {
    if (code !== undefined && (!Number.isInteger(code) || code < 1_000 || code > 4_999)) {
      throw new Error(`The Mesh relay socket close code ${String(code)} is invalid.`);
    }
    let normalizedReason = reason ?? "";
    if (Buffer.byteLength(normalizedReason, "utf8") > 123) {
      throw new Error("The Mesh relay socket close reason exceeds 123 bytes.");
    }
    normalizedReason = normalizedReason.replace(/[\r\n\0]/g, " ");
    if (this.state === CLOSING || this.state === CLOSED) {
      return;
    }
    const resolved = { code: code ?? 1_000, reason: normalizedReason };
    this.state = CLOSING;
    this.queue.length = 0;
    this.queuedBytes = 0;
    if (this.stream) {
      this.stream.close(resolved.code, resolved.reason);
      return;
    }
    this.closeRequested = resolved;
    this.openController.abort();
  }

  private async start(
    open: (signal: AbortSignal) => Promise<MeshRelayDataStream>,
  ): Promise<void> {
    let stream: MeshRelayDataStream;
    try {
      stream = await open(this.openController.signal);
    } catch (error) {
      if (this.closeRequested) {
        const requested = this.closeRequested;
        this.closeRequested = undefined;
        this.dispatchClose(requested.code, requested.reason);
        return;
      }
      log.warn("The Mesh relay socket could not be opened", {
        error: String(error),
      });
      this.fail(error instanceof Error
        ? error.message
        : "The Mesh relay socket could not be opened.");
      return;
    }
    this.stream = stream;
    if (this.closeRequested) {
      const requested = this.closeRequested;
      this.closeRequested = undefined;
      stream.close(requested.code, requested.reason);
      this.dispatchClose(requested.code, requested.reason);
      stream.dispose();
      return;
    }
    this.state = OPEN;
    const queued = [...this.queue];
    this.queue.length = 0;
    this.queuedBytes = 0;
    try {
      for (const payload of queued) {
        stream.send(payload);
      }
    } catch (error) {
      log.warn("A queued Mesh relay socket frame could not be sent", {
        error: String(error),
      });
      this.fail("The Mesh relay socket could not flush its queued frames.");
      return;
    }
    this.emit("open", new Event("open"));
    await this.consume(stream);
  }

  private async consume(stream: MeshRelayDataStream): Promise<void> {
    try {
      while (true) {
        const item = await stream.next();
        if (item.kind === "closed") {
          this.dispatchClose(
            item.code,
            item.reason || "The Mesh relay socket closed.",
          );
          return;
        }
        const data = item.kind === "text"
          ? item.text
          : this.decodeBinary(item.bytes);
        this.emit("message", new MessageEvent("message", { data }));
      }
    } catch (error) {
      log.warn("The Mesh relay socket read loop failed", { error: String(error) });
      this.fail("The Mesh relay socket failed.");
    } finally {
      stream.dispose();
    }
  }

  private decodeBinary(bytes: Uint8Array): ArrayBuffer | Blob {
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return this.binaryType === "blob" ? new Blob([buffer]) : buffer;
  }

  private fail(reason: string): void {
    if (this.state !== CLOSED) {
      this.emit("error", new Event("error"));
    }
    this.openController.abort();
    this.stream?.close(1011, reason);
    this.dispatchClose(1011, reason);
  }

  private dispatchClose(code: number, reason: string): void {
    if (this.closeDispatched) {
      return;
    }
    this.closeDispatched = true;
    this.state = CLOSED;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.emit("close", new CloseEvent("close", { code, reason, wasClean: code === 1_000 }));
  }

  private emit(type: "open" | "error" | "message" | "close", event: Event): void {
    try {
      if (type === "open") {
        this.onopen?.(event);
      } else if (type === "error") {
        this.onerror?.(event);
      } else if (type === "message") {
        this.onmessage?.(event as MessageEvent);
      } else {
        this.onclose?.(event as CloseEvent);
      }
    } catch (error) {
      log.warn("A Mesh relay socket handler threw", {
        type,
        error: String(error),
      });
    }
    this.dispatchEvent(event);
  }
}
