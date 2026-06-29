import { describe, expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";

import { close, startPreviewBridgeKeepalive } from "../../src/api/websocket/connection";
import type { WebSocketData } from "../../src/api/websocket/types";

async function waitForMessage(messages: string[], predicate: (message: string) => boolean): Promise<string> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    const message = messages.find(predicate);
    if (message) {
      return message;
    }
    await Bun.sleep(5);
  }
  throw new Error(`Timed out waiting for message. Last messages: ${JSON.stringify(messages)}`);
}

function createPreviewBridgeSocket(messages: string[]): ServerWebSocket<WebSocketData> {
  return {
    data: {
      previewBridgeMode: true,
    },
    send(data: string | BufferSource) {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data as Uint8Array;
      messages.push(typeof data === "string" ? data : new TextDecoder().decode(bytes));
      return 1;
    },
    close() {},
  } as ServerWebSocket<WebSocketData>;
}

describe("preview bridge keepalive", () => {
  test("sends bridge pings while the preview bridge is otherwise idle", async () => {
    const messages: string[] = [];
    const socket = createPreviewBridgeSocket(messages);
    const timer = startPreviewBridgeKeepalive(socket, 5);

    try {
      const message = await waitForMessage(messages, (candidate) => candidate.includes("bridge.ping"));
      expect(JSON.parse(message)).toEqual({ type: "bridge.ping" });
    } finally {
      clearInterval(timer);
    }
  });

  test("clears the keepalive timer when the preview bridge closes", async () => {
    const messages: string[] = [];
    const socket = createPreviewBridgeSocket(messages);
    socket.data.previewBridgeKeepalive = startPreviewBridgeKeepalive(socket, 5);

    close(socket);

    expect(socket.data.previewBridgeKeepalive).toBeUndefined();
  });
});
