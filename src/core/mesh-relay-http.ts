/**
 * Authoritative inbound Mesh HTTP dispatch; client framing lives in the portable initiator.
 */
import { createLogger } from "@pablozaiden/webapp/server";
import type { MeshProtocolVersion } from "@/shared/mesh-protocol";
import { MESH_RELAY_CLIENT_ENROLLMENT_PATH } from "@/shared/mesh-relay";
import { utf8ByteLength } from "@/shared/encoding";
import { MeshRelayStreamError } from "./mesh-relay-errors";
import { markMeshRelayRequestTransport } from "./mesh-transport-security";
import type { MeshRelayDataStream } from "./mesh-relay-data-stream";
import { MESH_RELAY_RESPONSE_FLOW_HEADER, MESH_RELAY_RESPONSE_FLOW_VERSION, MeshRelayHttpResponseSender } from "./mesh-relay-http-response-flow";
import { MESH_RELAY_MAX_HEADER_BYTES, MESH_RELAY_MAX_HEADER_COUNT, MESH_RELAY_MAX_ENROLLMENT_BODY_BYTES, MESH_RELAY_PROHIBITED_HEADERS, MESH_RELAY_STREAM_CLOSE_DISPATCH_FAILED, MESH_RELAY_STREAM_CLOSE_PROTOCOL_ERROR, MESH_RELAY_STREAM_CLOSE_REQUEST_FAILED, MESH_RELAY_STREAM_CLOSE_TIMEOUT } from "./mesh-relay-policy";
import { invalidFrame, parseMeshRelayHttpFrame, STATUSLESS_BODY_STATUSES, performMeshRelayHttpRequest as performClientRequest, type MeshRelayHttpRequestInit } from "./mesh-relay-http-client";
export { parseMeshRelayHttpFrame, sanitizeMeshRelayRequestHeaders, MESH_RELAY_RESPONSE_HEADER_TIMEOUT_MS } from "./mesh-relay-http-client";
export type { MeshRelayHttpFrame, MeshRelayHttpRequestEndFrame, MeshRelayHttpResponseFrame, MeshRelayHttpResponseEndFrame, MeshRelayHttpErrorFrame, MeshRelayHttpRequestInit } from "./mesh-relay-http-client";

const log = createLogger("core:mesh-relay-http");
export const MESH_RELAY_REQUEST_DRAIN_TIMEOUT_MS = 15_000;
const STRIPPED_RESPONSE_HEADERS = new Set(["content-encoding", "content-length"]);

export async function performMeshRelayHttpRequest(stream: MeshRelayDataStream, init: MeshRelayHttpRequestInit = {}): Promise<Response> {
  return await performClientRequest(stream, { ...init, logger: init.logger ?? log });
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
    bytes += utf8ByteLength(name) + utf8ByteLength(value);
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

export interface ServeMeshRelayHttpStreamOptions {
  secureTransport?: boolean;
  transportProtocolVersion: MeshProtocolVersion;
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
  const responseFlowControl = options.headers[MESH_RELAY_RESPONSE_FLOW_HEADER]
    === String(MESH_RELAY_RESPONSE_FLOW_VERSION);
  const body = new MeshRelayRequestBody(bodyless);
  const requestBodyLimit = (url.pathname === "/api/mesh/internal/enrollment"
    || url.pathname === MESH_RELAY_CLIENT_ENROLLMENT_PATH)
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
  markMeshRelayRequestTransport(request, {
    secure: options.secureTransport === true,
    protocolVersion: options.transportProtocolVersion,
  });

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
      ...(responseFlowControl ? { responseFlowControl: MESH_RELAY_RESPONSE_FLOW_VERSION } : {}),
    }));
    const sender = responseFlowControl ? new MeshRelayHttpResponseSender(stream) : undefined;
    if (sender) {
      // After the headers, the initiator ends its upload. Hand the single
      // inbound reader from the request drain to response acknowledgements.
      if (!(await settleRequestDrain(drainFailure))) {
        throw new MeshRelayStreamError(
          "mesh_relay_stream_timeout",
          "The Mesh relay request body drain timed out.",
          { status: 504 },
        );
      }
      if (drainError) throw drainError;
    }
    if (response.body && !STATUSLESS_BODY_STATUSES.has(response.status)) {
      responseReader = response.body.getReader();
      while (!stream.closed) {
        const { done, value } = await responseReader.read();
        if (done) {
          break;
        }
        if (value.byteLength > 0) {
          if (sender) {
            await sender.send(value);
          } else {
            await stream.sendBinaryChunks(value);
          }
        }
      }
    }
    if (sender) {
      await sender.complete();
    } else if (!stream.closed) {
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
