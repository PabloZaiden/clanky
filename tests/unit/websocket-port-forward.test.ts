import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { websocketHandlers, type WebSocketData } from "../../src/api/websocket";

function createTerminalSocket(data: WebSocketData): ServerWebSocket<WebSocketData> & {
  send: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
} {
  return {
    data,
    send: mock(() => {}),
    close: mock(() => {}),
  } as unknown as ServerWebSocket<WebSocketData> & {
    send: ReturnType<typeof mock>;
    close: ReturnType<typeof mock>;
  };
}

describe("websocketHandlers port-forward mode", () => {
  test("forwards binary messages to an open upstream proxy as Uint8Array data", () => {
    const close = mock(() => {});
    const send = mock(() => {});
    const proxySocket = {
      readyState: WebSocket.OPEN,
      send,
    } as unknown as WebSocket;
    const ws = {
      data: {
        portForwardMode: true,
        portForwardId: "forward-open",
        proxySocket,
      } as WebSocketData,
      close,
    } as unknown as ServerWebSocket<WebSocketData>;

    websocketHandlers.message(ws, Buffer.from([1, 2, 3]));

    expect(send).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();

    const firstCall = send.mock.calls[0] as unknown[] | undefined;
    const payload = firstCall?.[0];
    expect(payload).toBeInstanceOf(Uint8Array);
    if (!(payload instanceof Uint8Array)) {
      throw new Error("Expected upstream proxy payload to be a Uint8Array");
    }
    expect(Array.from(payload)).toEqual([1, 2, 3]);
  });

  test("silently drops messages when the upstream proxy is still connecting", () => {
    const close = mock(() => {});
    const send = mock(() => {});
    const proxySocket = {
      readyState: WebSocket.CONNECTING,
      send,
    } as unknown as WebSocket;
    const ws = {
      data: {
        portForwardMode: true,
        portForwardId: "forward-1",
        proxySocket,
      } as WebSocketData,
      close,
    } as unknown as ServerWebSocket<WebSocketData>;

    websocketHandlers.message(ws, "not-json");

    expect(send).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });

  test("closes the client socket when the upstream proxy is closed", () => {
    const close = mock(() => {});
    const send = mock(() => {});
    const proxySocket = {
      readyState: WebSocket.CLOSED,
      send,
    } as unknown as WebSocket;
    const ws = {
      data: {
        portForwardMode: true,
        portForwardId: "forward-2",
        proxySocket,
      } as WebSocketData,
      close,
    } as unknown as ServerWebSocket<WebSocketData>;

    websocketHandlers.message(ws, "not-json");

    expect(send).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(1011, "Upstream proxy is not open");
  });

  test("closes the client socket when the upstream proxy is missing", () => {
    const close = mock(() => {});
    const ws = {
      data: {
        portForwardMode: true,
        portForwardId: "forward-3",
        proxySocket: undefined,
      } as WebSocketData,
      close,
    } as unknown as ServerWebSocket<WebSocketData>;

    websocketHandlers.message(ws, "not-json");

    expect(close).toHaveBeenCalledWith(1011, "Upstream proxy is not open");
  });
});

describe("websocketHandlers standalone terminal auth", () => {
  afterEach(() => {
    mock.restore();
  });

  test("waits for a terminal.auth message before connecting a standalone SSH terminal", () => {
    const startBridgeSpy = spyOn(websocketHandlers, "startTerminalBridge").mockResolvedValue();
    const ws = createTerminalSocket({
      terminalMode: true,
      sshServerSessionId: "standalone-ssh-1",
    });

    websocketHandlers.open(ws);
    expect(startBridgeSpy).not.toHaveBeenCalled();

    websocketHandlers.message(ws, JSON.stringify({
      type: "terminal.auth",
      credentialToken: "token-123",
    }));

    expect(startBridgeSpy).toHaveBeenCalledWith(ws, "token-123");
  });

  test("rejects standalone terminal messages that omit the credential token auth handshake", () => {
    const sendTerminalAuthErrorSpy = spyOn(websocketHandlers, "sendTerminalAuthError").mockImplementation(() => {});
    const ws = createTerminalSocket({
      terminalMode: true,
      sshServerSessionId: "standalone-ssh-2",
    });

    websocketHandlers.open(ws);
    websocketHandlers.message(ws, JSON.stringify({ type: "terminal.input", data: "ls" }));

    expect(sendTerminalAuthErrorSpy).toHaveBeenCalledWith(
      ws,
      "terminal.auth is required before using a standalone SSH terminal",
    );
  });
});
