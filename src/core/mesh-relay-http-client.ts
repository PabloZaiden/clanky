/**
 * HTTP framing for Mesh relay data streams.
 *
 * A relay data stream carries one HTTP exchange as opaque frames:
 * binary frames are body bytes and JSON text frames are metadata. The
 * initiator sends body chunks followed by `http.request.end`; the receiver
 * replies with `http.response`, body chunks, and `http.response.end`. Bodies
 * are never buffered in full on either side.
 */

import { utf8ByteLength } from "@/shared/encoding";
import type { CollaborationClientLogger } from "../client-sdk/collaboration/types";
import { MeshRelayStreamError } from "./mesh-relay-errors";
import type { MeshRelayDataStream } from "./mesh-relay-data-stream";
import {
  MESH_RELAY_RESPONSE_FLOW_VERSION,
} from "./mesh-relay-http-response-flow";
import {
  MESH_RELAY_MAX_HEADER_BYTES,
  MESH_RELAY_MAX_HEADER_COUNT,
  MESH_RELAY_PROHIBITED_HEADERS,
  MESH_RELAY_STREAM_CLOSE_CANCELLED,
  MESH_RELAY_STREAM_CLOSE_DISPATCH_FAILED,
  MESH_RELAY_STREAM_CLOSE_PROTOCOL_ERROR,
  MESH_RELAY_STREAM_CLOSE_REQUEST_FAILED,
  MESH_RELAY_STREAM_CLOSE_TIMEOUT,
} from "./mesh-relay-policy";

export const MESH_RELAY_RESPONSE_HEADER_TIMEOUT_MS = 30_000;
export const STATUSLESS_BODY_STATUSES = new Set([101, 204, 205, 304]);

export interface MeshRelayHttpRequestEndFrame {
  type: "http.request.end";
}

export interface MeshRelayHttpResponseFrame {
  type: "http.response";
  status: number;
  statusText: string;
  headers: Record<string, string>;
  responseFlowControl?: typeof MESH_RELAY_RESPONSE_FLOW_VERSION;
}

export interface MeshRelayHttpResponseEndFrame {
  type: "http.response.end";
}

export interface MeshRelayHttpErrorFrame {
  type: "http.error";
  code: string;
  message: string;
}

export type MeshRelayHttpFrame =
  | MeshRelayHttpRequestEndFrame
  | MeshRelayHttpResponseFrame
  | MeshRelayHttpResponseEndFrame
  | MeshRelayHttpErrorFrame;

export function invalidFrame(cause?: unknown): MeshRelayStreamError {
  return new MeshRelayStreamError(
    "mesh_relay_http_frame_invalid",
    "The Mesh relay HTTP frame is invalid.",
    cause === undefined ? {} : { cause },
  );
}

function parseHeaderRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidFrame();
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MESH_RELAY_MAX_HEADER_COUNT) {
    throw invalidFrame();
  }
  const headers: Record<string, string> = {};
  let bytes = 0;
  for (const [name, headerValue] of entries) {
    if (typeof headerValue !== "string" || !/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name)) {
      throw invalidFrame();
    }
    if (/[\r\n\0]/.test(headerValue)) {
      throw invalidFrame();
    }
    bytes += utf8ByteLength(name) + utf8ByteLength(headerValue);
    if (bytes > MESH_RELAY_MAX_HEADER_BYTES) {
      throw invalidFrame();
    }
    headers[name] = headerValue;
  }
  return headers;
}

export function parseMeshRelayHttpFrame(text: string): MeshRelayHttpFrame {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw invalidFrame(error);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalidFrame();
  }
  const record = raw as Record<string, unknown>;
  switch (record["type"]) {
    case "http.request.end":
      return { type: "http.request.end" };
    case "http.response.end":
      return { type: "http.response.end" };
    case "http.error":
      if (
        typeof record["code"] !== "string"
        || typeof record["message"] !== "string"
      ) {
        throw invalidFrame();
      }
      return {
        type: "http.error",
        code: record["code"],
        message: record["message"].slice(0, 2_048),
      };
    case "http.response": {
      const status = record["status"];
      if (
        typeof status !== "number"
        || !Number.isInteger(status)
        || status < 100
        || status > 599
        || typeof record["statusText"] !== "string"
        || (
          record["responseFlowControl"] !== undefined
          && record["responseFlowControl"] !== MESH_RELAY_RESPONSE_FLOW_VERSION
        )
      ) {
        throw invalidFrame();
      }
      return {
        type: "http.response",
        status,
        statusText: record["statusText"].slice(0, 512),
        headers: parseHeaderRecord(record["headers"]),
        ...(record["responseFlowControl"] === MESH_RELAY_RESPONSE_FLOW_VERSION
          ? { responseFlowControl: MESH_RELAY_RESPONSE_FLOW_VERSION }
          : {}),
      };
    }
    default:
      throw invalidFrame();
  }
}

/** Normalize caller headers to the exact set the relay accepts. */
export function sanitizeMeshRelayRequestHeaders(
  init: HeadersInit | undefined,
): Record<string, string> {
  const headers = new Headers(init ?? {});
  const sanitized: Record<string, string> = {};
  let bytes = 0;
  for (const [rawName, rawValue] of headers.entries()) {
    const name = rawName.toLowerCase();
    if (MESH_RELAY_PROHIBITED_HEADERS.has(name) || name.startsWith("proxy-")) {
      continue;
    }
    if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name)) {
      throw new MeshRelayStreamError(
        "mesh_relay_header_invalid",
        `The Mesh relay header "${rawName}" is not a valid header name.`,
        { status: 400 },
      );
    }
    const value = rawValue.trim();
    if (/[\r\n\0]/.test(value)) {
      throw new MeshRelayStreamError(
        "mesh_relay_header_invalid",
        `The Mesh relay header "${rawName}" contains invalid characters.`,
        { status: 400 },
      );
    }
    bytes += utf8ByteLength(name) + utf8ByteLength(value);
    if (
      bytes > MESH_RELAY_MAX_HEADER_BYTES
      || Object.keys(sanitized).length >= MESH_RELAY_MAX_HEADER_COUNT
    ) {
      throw new MeshRelayStreamError(
        "mesh_relay_headers_too_large",
        "The Mesh relay request headers exceed the transport limit.",
        { status: 431 },
      );
    }
    sanitized[name] = value;
  }
  return sanitized;
}


function toBodyStream(
  body: BodyInit | null | undefined,
): ReadableStream<Uint8Array> | null {
  if (body === null || body === undefined) {
    return null;
  }
  if (body instanceof ReadableStream) {
    return body as ReadableStream<Uint8Array>;
  }
  return new Response(body).body;
}

/** Read the relay stream as an HTTP body, closing the stream when cancelled. */
function readBodyStream(
  stream: MeshRelayDataStream,
  finish: (code: number, reason: string) => void,
  responseFlowControl: boolean,
): ReadableStream<Uint8Array> {
  let finished = false;
  let consumedBytes = 0;
  let deliveredBytes = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      if (finished) {
        return;
      }
      try {
        // The next pull confirms consumption, not just arrival in our queue.
        if (responseFlowControl && consumedBytes !== deliveredBytes && !stream.closed) {
          stream.send(JSON.stringify({ type: "http.response.ack", bytes: deliveredBytes }));
          consumedBytes = deliveredBytes;
        }
        const item = await stream.next();
        if (item.kind === "binary") {
          deliveredBytes += item.bytes.byteLength;
          controller.enqueue(item.bytes);
          return;
        }
        finished = true;
        if (item.kind === "closed") {
          finish(item.code, item.reason);
          controller.error(new MeshRelayStreamError(
            "mesh_relay_response_truncated",
            item.reason.trim() || "The Mesh relay response ended before it completed.",
            { status: 502 },
          ));
          return;
        }
        const frame = parseMeshRelayHttpFrame(item.text);
        if (frame.type === "http.response.end") {
          finish(1000, "The Mesh relay response completed");
          controller.close();
          return;
        }
        if (frame.type === "http.error") {
          finish(
            MESH_RELAY_STREAM_CLOSE_DISPATCH_FAILED,
            "The Mesh relay peer failed to serve the response",
          );
          controller.error(
            new MeshRelayStreamError(frame.code, frame.message, { status: 502 }),
          );
          return;
        }
        finish(
          MESH_RELAY_STREAM_CLOSE_PROTOCOL_ERROR,
          "The Mesh relay response framing was invalid",
        );
        controller.error(invalidFrame());
      } catch (error) {
        finished = true;
        finish(
          MESH_RELAY_STREAM_CLOSE_PROTOCOL_ERROR,
          "The Mesh relay response framing was invalid",
        );
        controller.error(error);
      }
    },
    cancel(): void {
      finished = true;
      finish(
        MESH_RELAY_STREAM_CLOSE_CANCELLED,
        "The Mesh relay response body was cancelled",
      );
    },
  }, { highWaterMark: responseFlowControl ? 0 : 1 });
}

function closeFailedHttpRequest(
  stream: MeshRelayDataStream,
  error: unknown,
): void {
  if (stream.closed) {
    return;
  }
  const code = error instanceof MeshRelayStreamError
    ? error.code
    : "";
  if (code === "mesh_relay_request_aborted") {
    stream.close(
      MESH_RELAY_STREAM_CLOSE_CANCELLED,
      "The Mesh relay request was aborted",
    );
    return;
  }
  if (code === "mesh_relay_stream_timeout") {
    stream.close(
      MESH_RELAY_STREAM_CLOSE_TIMEOUT,
      "The Mesh relay request timed out",
    );
    return;
  }
  if (code === "mesh_relay_http_frame_invalid") {
    stream.close(
      MESH_RELAY_STREAM_CLOSE_PROTOCOL_ERROR,
      "The Mesh relay response framing was invalid",
    );
    return;
  }
  if (code === "mesh_relay_dispatch_failed") {
    stream.close(
      MESH_RELAY_STREAM_CLOSE_DISPATCH_FAILED,
      "The Mesh relay peer failed to serve the request",
    );
    return;
  }
  stream.close(
    MESH_RELAY_STREAM_CLOSE_REQUEST_FAILED,
    "The Mesh relay request failed",
  );
}


export interface MeshRelayHttpRequestInit {
  logger?: CollaborationClientLogger;
  body?: BodyInit | null;
  signal?: AbortSignal;
  responseHeaderTimeoutMs?: number;
  onDispatch?: () => void;
  responseFlowControl?: boolean;
}

/**
 * Drive one HTTP exchange from the initiator side and return a streaming
 * `Response` whose status, headers and body come from the peer verbatim.
 */
export async function performMeshRelayHttpRequest(
  stream: MeshRelayDataStream,
  init: MeshRelayHttpRequestInit = {},
): Promise<Response> {
  const log = init.logger ?? console;
  let bodyReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const cancelUpload = (): void => {
    void bodyReader?.cancel().catch(() => undefined);
  };
  const onAbort = (): void => {
    cancelUpload();
    stream.close(
      MESH_RELAY_STREAM_CLOSE_CANCELLED,
      "The Mesh relay request was aborted",
    );
  };
  if (init.signal?.aborted) {
    stream.close(
      MESH_RELAY_STREAM_CLOSE_CANCELLED,
      "The Mesh relay request was aborted",
    );
    throw new MeshRelayStreamError(
      "mesh_relay_request_aborted",
      "The Mesh relay request was aborted.",
      { status: 499 },
    );
  }
  init.signal?.addEventListener("abort", onAbort, { once: true });

  let settled = false;
  const release = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    init.signal?.removeEventListener("abort", onAbort);
  };

  // The peer may answer before the request body finishes (for example a
  // validation failure during an upload), so the body pump runs concurrently.
  const source = toBodyStream(init.body);
  const pump = (async (): Promise<void> => {
    if (!source) {
      stream.send(JSON.stringify({ type: "http.request.end" }));
      init.onDispatch?.();
      return;
    }
    bodyReader = source.getReader();
    try {
      while (!stream.closed) {
        const { done, value } = await bodyReader.read();
        if (done) {
          break;
        }
        if (value.byteLength > 0) {
          await stream.sendBinaryChunks(value);
        }
      }
      if (!stream.closed) {
        stream.send(JSON.stringify({ type: "http.request.end" }));
        init.onDispatch?.();
      }
    } finally {
      bodyReader.releaseLock();
      bodyReader = undefined;
    }
  })();
  void pump.catch((error: unknown) => {
    log.debug("The outbound Mesh relay request pump stopped", {
      error: String(error),
    });
    stream.close(
      MESH_RELAY_STREAM_CLOSE_REQUEST_FAILED,
      "The Mesh relay request body failed",
    );
  });

  try {
    const item = await stream.next(
      init.responseHeaderTimeoutMs ?? MESH_RELAY_RESPONSE_HEADER_TIMEOUT_MS,
    );
    if (item.kind === "closed") {
      cancelUpload();
      throw new MeshRelayStreamError(
        "mesh_relay_response_missing",
        item.reason.trim() || "The Mesh relay stream closed before a response.",
        { status: 502 },
      );
    }
    if (item.kind !== "text") {
      throw invalidFrame();
    }
    const frame = parseMeshRelayHttpFrame(item.text);
    if (frame.type === "http.error") {
      stream.close(
        MESH_RELAY_STREAM_CLOSE_DISPATCH_FAILED,
        "The Mesh relay peer failed to serve the request",
      );
      throw new MeshRelayStreamError(frame.code, frame.message, { status: 502 });
    }
    if (frame.type !== "http.response") {
      throw invalidFrame();
    }
    if (frame.responseFlowControl && !init.responseFlowControl) {
      throw invalidFrame();
    }
    cancelUpload();
    const finish = (code: number, reason: string): void => {
      release();
      if (!stream.closed) {
        stream.close(code, reason);
      }
      stream.dispose();
    };
    let body: ReadableStream<Uint8Array> | null;
    if (STATUSLESS_BODY_STATUSES.has(frame.status)) {
      const end = await stream.next(
        init.responseHeaderTimeoutMs ?? MESH_RELAY_RESPONSE_HEADER_TIMEOUT_MS,
      );
      if (end.kind === "closed") {
        throw new MeshRelayStreamError(
          "mesh_relay_response_truncated",
          end.reason.trim() || "The Mesh relay response ended before it completed.",
          { status: 502 },
        );
      }
      if (
        end.kind !== "text"
        || parseMeshRelayHttpFrame(end.text).type !== "http.response.end"
      ) {
        throw invalidFrame();
      }
      finish(1000, "The Mesh relay response completed");
      body = null;
    } else {
      body = readBodyStream(stream, finish, frame.responseFlowControl !== undefined);
    }
    return new Response(body, {
      status: frame.status,
      statusText: frame.statusText,
      headers: frame.headers,
    });
  } catch (error) {
    release();
    cancelUpload();
    closeFailedHttpRequest(stream, error);
    stream.dispose();
    throw error;
  }
}
