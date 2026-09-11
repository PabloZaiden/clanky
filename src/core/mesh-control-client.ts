import { DomainError } from "./domain-error";

const MESH_CONTROL_REQUEST_TIMEOUT_MS = 10_000;
const MESH_CONTROL_RESPONSE_MAX_BYTES = 64 * 1024;
const recognizedPeerErrors = new Map<string, string>([
  [
    "mesh_execution_configuration_stale",
    "The Mesh execution configuration changed before it could be saved.",
  ],
  [
    "execution_host_directory_invalid",
    "The selected directory does not exist on the execution host.",
  ],
]);

export interface MeshControlRequestOptions {
  headers?: Record<string, string>;
  tls?: Bun.TLSOptions;
  signal?: AbortSignal;
}

export interface MeshControlResponseJsonOptions {
  signal?: AbortSignal;
  maxBytes?: number;
}

function meshControlResponseAborted(): DomainError {
  return new DomainError(
    "mesh_control_response_aborted",
    "The Mesh control response was aborted.",
  );
}

function getSenderNodeId(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return "";
  }
  const record = payload as Record<string, unknown>;
  if ("requestedNodeId" in record) {
    return String(record["requestedNodeId"]);
  }
  if ("approvedByNodeId" in record) {
    return String(record["approvedByNodeId"]);
  }
  if ("senderNodeId" in record) {
    return String(record["senderNodeId"]);
  }
  if ("workerNodeId" in record) {
    return String(record["workerNodeId"]);
  }
  if ("controllerNodeId" in record) {
    return String(record["controllerNodeId"]);
  }
  return "";
}

export async function postMeshControlMessage(
  endpoint: string,
  payload: unknown,
  requestId: string,
  options: MeshControlRequestOptions = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MESH_CONTROL_REQUEST_TIMEOUT_MS);
  const abortListener = () => controller.abort();
  if (options.signal?.aborted) {
    controller.abort();
  } else {
    options.signal?.addEventListener("abort", abortListener, { once: true });
  }
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-clanky-mesh-node-id": getSenderNodeId(payload),
        "x-clanky-mesh-request-id": requestId,
        ...options.headers,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
      tls: options.tls,
    });
    if (!response.ok) {
      const body = await response.clone().json().catch(() => null) as {
        error?: unknown;
        message?: unknown;
      } | null;
      const peerError = typeof body?.error === "string"
        ? recognizedPeerErrors.get(body.error)
        : undefined;
      if (peerError) {
        throw new DomainError(body!.error as
          | "mesh_execution_configuration_stale"
          | "execution_host_directory_invalid", peerError, {
          details: { status: response.status, requestId },
        });
      }
      const peerMessage = typeof body?.message === "string"
        ? ` ${body.message}`
        : "";
      throw new DomainError(
        "mesh_control_request_rejected",
        `The peer rejected the mesh control request.${peerMessage}`,
        { details: { status: response.status, requestId } },
      );
    }
    return response;
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    if (options.signal?.aborted) {
      throw new DomainError(
        "mesh_control_request_aborted",
        "The Mesh control request was aborted.",
        { cause: error, details: { requestId } },
      );
    }
    throw new DomainError("mesh_control_request_unreachable", "The mesh peer could not be reached.", {
      cause: error,
      details: { requestId },
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortListener);
  }
}

export async function readMeshControlResponseJson<T>(
  response: Response,
  options: MeshControlResponseJsonOptions = {},
): Promise<T> {
  if (!response.body) {
    if (options.signal?.aborted) {
      throw meshControlResponseAborted();
    }
    return await response.json() as T;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const maxBytes = options.maxBytes ?? MESH_CONTROL_RESPONSE_MAX_BYTES;
  let abortHandler: (() => void) | undefined;
  const readBody = async (): Promise<string> => {
    let totalBytes = 0;
    let text = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return `${text}${decoder.decode()}`;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new DomainError(
          "mesh_control_response_too_large",
          "The Mesh control response exceeds the size limit.",
        );
      }
      text += decoder.decode(value, { stream: true });
    }
  };

  try {
    if (!options.signal) {
      return JSON.parse(await readBody()) as T;
    }
    const abortPromise = new Promise<never>((_, reject) => {
      abortHandler = () => {
        void reader.cancel();
        reject(meshControlResponseAborted());
      };
      if (options.signal!.aborted) {
        abortHandler();
      } else {
        options.signal!.addEventListener("abort", abortHandler, { once: true });
      }
    });
    return JSON.parse(await Promise.race([readBody(), abortPromise])) as T;
  } catch (error) {
    if (error instanceof DomainError) {
      throw error;
    }
    throw new DomainError(
      "mesh_control_response_invalid",
      "The Mesh control response is not valid JSON.",
      { cause: error },
    );
  } finally {
    if (abortHandler && options.signal) {
      options.signal.removeEventListener("abort", abortHandler);
    }
    reader.releaseLock();
  }
}
