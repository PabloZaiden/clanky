import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, test } from "bun:test";

import { runPreviewCommand } from "../../src/cli/preview";
import type { PreviewBridgeClientMessage, PreviewBridgeReadyMessage } from "../../src/types";

class FakeBridgeSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  sentMessages: PreviewBridgeClientMessage[] = [];

  constructor() {
    super();
    queueMicrotask(() => {
      this.readyState = WebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data !== "string") {
      return;
    }
    const message = JSON.parse(data) as PreviewBridgeClientMessage;
    this.sentMessages.push(message);
    if (message.type === "hello") {
      const ready = {
        type: "ready",
        previewId: "preview-1",
        workspaceId: "workspace-1",
      } satisfies PreviewBridgeReadyMessage;
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(ready) }));
      });
    }
  }

  close(): void {
    this.readyState = WebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent("close"));
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for preview listener condition");
}

describe("CLI preview listener", () => {
  test("opens browser websocket streams from captured metadata instead of retained Request objects", async () => {
    const previousCliHome = process.env["CLANKY_CLI_HOME"];
    const cliHome = await mkdtemp(join(tmpdir(), "clanky-cli-preview-listener-"));
    process.env["CLANKY_CLI_HOME"] = cliHome;
    let bridgeSocket: FakeBridgeSocket | undefined;
    const authFetch: typeof fetch = Object.assign(
      async () => Response.json({
        authenticated: true,
        authKind: "anonymous",
        subject: null,
        clientId: null,
        scope: null,
      }),
      { preconnect: fetch.preconnect },
    );
    let openBrowserSocket: ((ws: { data: { headers: Array<[string, string]>; path: string; streamId: string }; send: () => void; close: () => void }) => void) | undefined;
    const serve = ((options: {
      websocket: {
        open: typeof openBrowserSocket;
      };
    }) => {
      openBrowserSocket = options.websocket.open;
      return {
        port: 43124,
        stop() {},
      };
    }) as unknown as typeof Bun.serve;

    try {
      const resultPromise = runPreviewCommand(
        {
          baseUrl: "http://localhost:3000",
          workspace: "workspace-1",
          port: 3000,
          remoteHost: "127.0.0.1",
          host: "127.0.0.1",
          localPort: 43124,
          path: "/myapp",
          open: false,
        },
        {
          fetchFn: authFetch,
          now: () => new Date("2026-01-01T00:00:00.000Z"),
          createSocket: () => {
            bridgeSocket = new FakeBridgeSocket();
            return bridgeSocket as unknown as WebSocket;
          },
          serve,
          out: () => {},
          err: () => {},
          getHostname: () => "test-host",
          registerSignalHandler: () => () => {},
        },
      );

      await waitFor(() => typeof openBrowserSocket === "function");
      openBrowserSocket!({
        data: {
          headers: [["host", "127.0.0.1:43124"]],
          path: "/myapp/socket?token=1",
          streamId: "browser-ws-1",
        },
        send() {},
        close() {},
      });
      await waitFor(() => bridgeSocket?.sentMessages.some((message) => message.type === "websocket.open") ?? false);
      bridgeSocket!.close();

      expect(await resultPromise).toBe(0);
      expect(bridgeSocket!.sentMessages).toContainEqual({
        type: "websocket.open",
        streamId: "browser-ws-1",
        path: "/myapp/socket?token=1",
        headers: [["host", "127.0.0.1:43124"]],
      });
    } finally {
      if (previousCliHome === undefined) {
        delete process.env["CLANKY_CLI_HOME"];
      } else {
        process.env["CLANKY_CLI_HOME"] = previousCliHome;
      }
      await rm(cliHome, { recursive: true, force: true });
    }
  });
});
