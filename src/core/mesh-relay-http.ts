/**
 * HTTP framing for Mesh relay data streams.
 *
 * A relay data stream carries one HTTP exchange as opaque frames:
 * binary frames are body bytes and JSON text frames are metadata. The
 * initiator sends body chunks followed by `http.request.end`; the receiver
 * replies with `http.response`, body chunks, and `http.response.end`. Bodies
 * are never buffered in full on either side.
 */

import { createLogger } from "@pablozaiden/webapp/server";
import { MeshRelayStreamError } from "./mesh-relay-errors";
import type { MeshRelayDataStream } from "./mesh-relay-data-stream";
import {
  MESH_RELAY_MAX_HEADER_BYTES,
  MESH_RELAY_MAX_HEADER_COUNT,
  MESH_RELAY_MAX_ENROLLMENT_BODY_BYTES,
  MESH_RELAY_PROHIBITED_HEADERS,
  MESH_RELAY_STREAM_CLOSE_CANCELLED,
  MESH_RELAY_STREAM_CLOSE_DISPATCH_FAILED,
  MESH_RELAY_STREAM_CLOSE_PROTOCOL_ERROR,
  MESH_RELAY_STREAM_CLOSE_REQUEST_FAILED,
  MESH_RELAY_STREAM_CLOSE_TIMEOUT,
} from "./mesh-relay-policy";

const log = createLogger("core:mesh-relay-http");

export const MESH_RELAY_RESPONSE_HEADER_TIMEOUT_MS = 30_000;
export const MESH_RELAY_REQUEST_DRAIN_TIMEOUT_MS = 15_000;
const STATUSLESS_BODY_STATUSES = new Set([101, 204, 205, 304]);
/** Response headers that describe the physical HTTP framing of the origin. */
const STRIPPED_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
]);

export interface MeshRelayHttpRequestEndFrame {
  type: "http.request.end";
}

export interface MeshRelayHttpResponseFrame {
  type: "http.response";
  status: number;
  statusText: string;
  headers: Record<string, string>;
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

function invalidFrame(cause?: unknown): MeshRelayStreamError {
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
    bytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(headerValue, "utf8");
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
      ) {
        throw invalidFrame();
      }
      return {
        type: "http.response",
        status,
        statusText: record["statusText"].slice(0, 512),
        headers: parseHeaderRecord(record["headers"]),
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
    bytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
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

function sanitizeResponseHeaders(headers: Headers): Record<string, string> {
  const sanitized: Record<string, string> = {};
  let bytes = 0;
  for (const [rawName, rawValue] of headers.entries()) {
    const name = rawName.toLowerCase();
    if (
      MESH_RELAY_PROHIBITED_HEADERS.has(name)
      || STRIPPED_RESPONSE_HEADERS.has(name)
      || name.startsWith("proxy-")
      || !/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(name)
    ) {
      continue;
    }
    const value = rawValue.replace(/[\r\n\0]/g, " ").trim();
    bytes += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8");
    if (
      bytes > MESH_RELAY_MAX_HEADER_BYTES
      || Object.keys(sanitized).length >= MESH_RELAY_MAX_HEADER_COUNT
    ) {
      break;
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
): ReadableStream<Uint8Array> {
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller): Promise<void> {
      if (finished) {
        return;
      }
      const item = await stream.next();
      if (item.kind === "binary") {
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
      try {
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
  });
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

function closeFailedRequestDrain(
  stream: MeshRelayDataStream,
  error: unknown,
): void {
  if (stream.closed) {
    return;
  }
  if (
    error instanceof MeshRelayStreamError
    && (
      error.code === "mesh_relay_http_frame_invalid"
      || error.code === "mesh_relay_request_too_large"
    )
  ) {
    stream.close(
      MESH_RELAY_STREAM_CLOSE_PROTOCOL_ERROR,
      "The Mesh relay request framing was invalid",
    );
    return;
  }
  stream.close(
    MESH_RELAY_STREAM_CLOSE_REQUEST_FAILED,
    "The Mesh relay request body failed",
  );
}

export interface MeshRelayHttpRequestInit {
  body?: BodyInit | null;
  signal?: AbortSignal;
  responseHeaderTimeoutMs?: number;
}

/**
 * Drive one HTTP exchange from the initiator side and return a streaming
 * `Response` whose status, headers and body come from the peer verbatim.
 */
export async function performMeshRelayHttpRequest(
  stream: MeshRelayDataStream,
  init: MeshRelayHttpRequestInit = {},
): Promise<Response> {
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
      body = readBodyStream(stream, finish);
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

export interface ServeMeshRelayHttpStreamOptions {
  stream: MeshRelayDataStream;
  method: string;
  path: string;
  headers: Record<string, string>;
  initiatorNodeId: string;
  dispatch(request: Request): Promise<Response | undefined>;
  reportStatus(status: number): void;
}

const relayRequestInitiators = new WeakMap<Request, string>();

/** Return the authenticated relay peer that initiated an in-process request. */
export function getMeshRelayRequestInitiatorNodeId(
  request: Request,
): string | undefined {
  return relayRequestInitiators.get(request);
}

/**
 * Backpressured request body sink.
 *
 * The inbound read loop owns the stream so the request frames are always
 * drained to `http.request.end`, even when the handler never reads the body.
 * Closing a socket while the peer still has frames in flight resets the
 * connection and discards the response, so the drain is mandatory.
 */
class MeshRelayRequestBody {
  readonly stream: ReadableStream<Uint8Array>;
  private controller!: ReadableStreamDefaultController<Uint8Array>;
  private releasePull: () => void = () => {};
  private pullable: Promise<void>;
  private draining: boolean;
  private finished = false;

  constructor(discard: boolean) {
    this.draining = discard;
    this.pullable = new Promise<void>((resolve) => {
      this.releasePull = resolve;
    });
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller): void => {
        this.controller = controller;
      },
      pull: (): void => {
        this.releasePull();
      },
      cancel: (): void => {
        this.draining = true;
        this.finished = true;
        this.releasePull();
      },
    }, { highWaterMark: 1 });
    if (discard) {
      this.releasePull();
    }
  }

  async enqueue(bytes: Uint8Array): Promise<void> {
    if (this.draining || this.finished) {
      return;
    }
    await this.pullable;
    if (this.draining || this.finished) {
      return;
    }
    this.pullable = new Promise<void>((resolve) => {
      this.releasePull = resolve;
    });
    this.controller.enqueue(bytes);
  }

  discard(): void {
    if (this.finished) {
      return;
    }
    this.draining = true;
    this.finished = true;
    this.releasePull();
    this.controller.close();
  }

  close(): void {
    if (this.finished || this.draining) {
      this.finished = true;
      return;
    }
    this.finished = true;
    this.controller.close();
  }

  fail(error: unknown): void {
    if (this.finished || this.draining) {
      this.finished = true;
      return;
    }
    this.finished = true;
    this.controller.error(error);
  }
}

/**
 * Serve one inbound HTTP exchange by reconstructing an in-process `Request`
 * and streaming the resulting `Response` back through the relay.
 */
export async function serveMeshRelayHttpStream(
  options: ServeMeshRelayHttpStreamOptions,
): Promise<void> {
  const { stream, method, path } = options;
  const controller = new AbortController();
  const url = new URL(path.startsWith("/") ? path : `/${path}`, "https://mesh.invalid");
  const bodyless = method === "GET" || method === "HEAD";
  const body = new MeshRelayRequestBody(bodyless);
  const requestBodyLimit = url.pathname === "/api/mesh/internal/enrollment"
    ? MESH_RELAY_MAX_ENROLLMENT_BODY_BYTES
    : Number.POSITIVE_INFINITY;
  let requestBodyBytes = 0;

  const drained = (async (): Promise<void> => {
    while (true) {
      const item = await stream.next();
      if (item.kind === "binary") {
        requestBodyBytes += item.bytes.byteLength;
        if (requestBodyBytes > requestBodyLimit) {
          const error = new MeshRelayStreamError(
            "mesh_relay_request_too_large",
            "The Mesh relay request body exceeds the transport limit.",
            { status: 413 },
          );
          body.fail(error);
          controller.abort();
          stream.close(1009, "Mesh relay request body exceeds the limit");
          throw error;
        }
        await body.enqueue(item.bytes);
        continue;
      }
      if (item.kind === "closed") {
        body.fail(new MeshRelayStreamError(
          "mesh_relay_request_truncated",
          "The Mesh relay request body ended early.",
        ));
        controller.abort();
        return;
      }
      const frame = parseMeshRelayHttpFrame(item.text);
      if (frame.type === "http.request.end") {
        body.close();
        return;
      }
      const error = invalidFrame();
      body.fail(error);
      throw error;
    }
  })();
  let drainError: unknown;
  const drainFailure = drained.catch((error: unknown) => {
    drainError = error;
    log.debug("The inbound Mesh relay request drain stopped", {
      path: url.pathname,
      error: String(error),
    });
  });

  const request = new Request(url, {
    method,
    headers: options.headers,
    signal: controller.signal,
    ...(bodyless ? {} : { body: body.stream, duplex: "half" }),
  } as RequestInit);
  relayRequestInitiators.set(request, options.initiatorNodeId);

  let responseReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await options.dispatch(request)
      ?? new Response(
        JSON.stringify({ error: "mesh_route_not_found", message: "Unknown Mesh route." }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    if (!bodyless) {
      body.discard();
    }
    options.reportStatus(response.status);
    stream.send(JSON.stringify({
      type: "http.response",
      status: response.status,
      statusText: response.statusText,
      headers: sanitizeResponseHeaders(response.headers),
    }));
    if (response.body && !STATUSLESS_BODY_STATUSES.has(response.status)) {
      responseReader = response.body.getReader();
      while (!stream.closed) {
        const { done, value } = await responseReader.read();
        if (done) {
          break;
        }
        if (value.byteLength > 0) {
          await stream.sendBinaryChunks(value);
        }
      }
    }
    if (!stream.closed) {
      stream.send(JSON.stringify({ type: "http.response.end" }));
    }
  } catch (error) {
    log.warn("The inbound Mesh relay HTTP stream failed", {
      path: url.pathname,
      error: String(error),
    });
    if (!stream.closed) {
      try {
        stream.send(JSON.stringify({
          type: "http.error",
          code: "mesh_relay_dispatch_failed",
          message: "The Mesh peer could not serve the relayed request.",
        }));
      } catch (sendError) {
        log.debug("The Mesh relay error frame could not be sent", {
          error: String(sendError),
        });
      }
    }
    if (!bodyless) {
      body.discard();
    }
    const requestDrained = await settleRequestDrain(drainFailure);
    controller.abort();
    if (!requestDrained) {
      stream.close(
        MESH_RELAY_STREAM_CLOSE_TIMEOUT,
        "The Mesh relay request body drain timed out",
      );
    } else if (drainError) {
      closeFailedRequestDrain(stream, drainError);
    } else {
      stream.close(
        MESH_RELAY_STREAM_CLOSE_DISPATCH_FAILED,
        "The Mesh relay request failed",
      );
    }
    stream.dispose();
    throw error;
  } finally {
    if (responseReader) {
      await responseReader.cancel().catch(() => undefined);
      responseReader.releaseLock();
    }
  }
  const requestDrained = await settleRequestDrain(drainFailure);
  controller.abort();
  if (!requestDrained) {
    stream.close(
      MESH_RELAY_STREAM_CLOSE_TIMEOUT,
      "The Mesh relay request body drain timed out",
    );
  } else if (drainError) {
    closeFailedRequestDrain(stream, drainError);
  } else {
    stream.close(1000, "The Mesh relay response completed");
  }
  stream.dispose();
}

/** Wait for the request drain so the socket is not closed mid-transfer. */
async function settleRequestDrain(drain: Promise<void>): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), MESH_RELAY_REQUEST_DRAIN_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      drain.then(() => true),
      expiry,
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
