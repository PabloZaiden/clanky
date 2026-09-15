/**
 * Outbound WebSocket seam used by the Mesh relay connector.
 *
 * The connector never touches the global `WebSocket` constructor directly so
 * that relay lifecycle behaviour can be driven deterministically in tests.
 */

export interface MeshRelayClientSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: BinaryType;
  send(data: string | ArrayBufferView | ArrayBufferLike): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: (event: Event) => void): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "close", listener: (event: CloseEvent) => void): void;
  addEventListener(type: "error", listener: (event: Event) => void): void;
  removeEventListener(type: "open", listener: (event: Event) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "close", listener: (event: CloseEvent) => void): void;
  removeEventListener(type: "error", listener: (event: Event) => void): void;
}

export type MeshRelayClientSocketFactory = (url: string) => MeshRelayClientSocket;

export const openMeshRelayClientSocket: MeshRelayClientSocketFactory = (url) =>
  new WebSocket(url) as unknown as MeshRelayClientSocket;

/**
 * WebSocket clients may only send close code `1000` or `3000`-`4999`. Mesh
 * gateways use reserved protocol codes such as `1008` and `1011`, so they are
 * carried through the relay in a private range and restored by the peer.
 */
export function toMeshRelayCloseCode(code: number | undefined): number {
  if (code === undefined || code === 1000) {
    return 1000;
  }
  if (code >= 3_000 && code <= 4_999) {
    return code;
  }
  if (code >= 1_001 && code <= 1_015) {
    return 4_900 + (code - 1_000);
  }
  return 4_011;
}

export function fromMeshRelayCloseCode(code: number): number {
  if (code >= 4_901 && code <= 4_915) {
    return 1_000 + (code - 4_900);
  }
  return code;
}

/** Truncate a close reason to the 123 byte WebSocket limit. */
export function toMeshRelayCloseReason(reason: string | undefined): string {
  let value = (reason ?? "").replace(/[\r\n\0]/g, " ");
  while (Buffer.byteLength(value, "utf8") > 123) {
    value = value.slice(0, -1);
  }
  return value;
}
