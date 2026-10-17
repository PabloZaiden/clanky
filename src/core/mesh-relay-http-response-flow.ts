/**
 * Opt-in, receiver-driven flow control for relayed HTTP response bodies.
 * Older peers never receive acknowledgement frames without negotiation.
 */

import {
  MESH_RELAY_BODY_CHUNK_BYTES,
  type MeshRelayDataStream,
} from "./mesh-relay-data-stream";
import { MeshRelayStreamError } from "./mesh-relay-errors";

export const MESH_RELAY_RESPONSE_FLOW_HEADER = "x-clanky-mesh-response-flow";
export const MESH_RELAY_RESPONSE_FLOW_VERSION = 1;
const MAX_IN_FLIGHT_FRAMES = 16;

function invalidAcknowledgement(cause?: unknown): MeshRelayStreamError {
  return new MeshRelayStreamError(
    "mesh_relay_http_frame_invalid",
    "The Mesh relay response acknowledgement is invalid.",
    { cause },
  );
}

export class MeshRelayHttpResponseSender {
  private sentBytes = 0;
  private readonly outstandingFrames: number[] = [];

  constructor(private readonly stream: MeshRelayDataStream) {}

  async send(bytes: Uint8Array): Promise<void> {
    for (let offset = 0; offset < bytes.byteLength; offset += MESH_RELAY_BODY_CHUNK_BYTES) {
      while (this.outstandingFrames.length >= MAX_IN_FLIGHT_FRAMES) {
        await this.readAcknowledgement();
      }
      const chunk = bytes.subarray(offset, offset + MESH_RELAY_BODY_CHUNK_BYTES);
      const sentBytes = this.sentBytes + chunk.byteLength;
      if (!Number.isSafeInteger(sentBytes)) throw invalidAcknowledgement();
      await this.stream.sendBinaryChunks(chunk);
      this.sentBytes = sentBytes;
      this.outstandingFrames.push(sentBytes);
    }
  }

  async complete(): Promise<void> {
    while (this.outstandingFrames.length > 0) {
      await this.readAcknowledgement();
    }
    this.stream.send(JSON.stringify({ type: "http.response.end" }));
    // The receiver closes only after consuming the end frame. A local flush
    // cannot confirm that the relay has delivered it to the other peer.
    const item = await this.stream.next();
    if (item.kind !== "closed") throw invalidAcknowledgement();
    if (item.code !== 1000) {
      throw new MeshRelayStreamError(
        "mesh_relay_response_truncated",
        item.reason.trim() || "The Mesh relay response completion was not confirmed.",
      );
    }
  }

  private async readAcknowledgement(): Promise<void> {
    // Missing credit means the consumer is backpressured, not disconnected.
    const item = await this.stream.next();
    if (item.kind === "closed") {
      throw new MeshRelayStreamError(
        "mesh_relay_stream_closed",
        item.reason.trim() || "The Mesh relay response was closed.",
      );
    }
    if (item.kind !== "text") throw invalidAcknowledgement();
    let raw: unknown;
    try {
      raw = JSON.parse(item.text);
    } catch (error) {
      throw invalidAcknowledgement(error);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw invalidAcknowledgement();
    }
    const frame = raw as Record<string, unknown>;
    if (frame["type"] !== "http.response.ack" || typeof frame["bytes"] !== "number") {
      throw invalidAcknowledgement();
    }
    const acknowledgedIndex = this.outstandingFrames.indexOf(frame["bytes"]);
    if (acknowledgedIndex < 0) throw invalidAcknowledgement();
    this.outstandingFrames.splice(0, acknowledgedIndex + 1);
  }
}
