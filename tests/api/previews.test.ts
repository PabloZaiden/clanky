import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, ensureDataDirectories, getDatabase, initializeDatabase } from "../../src/persistence/database";
import { createWorkspace } from "../../src/persistence/workspaces";
import { previewSessionManager } from "../../src/core/preview-session-manager";
import { runWithCurrentUser } from "../../src/core/user-context";
import type { PreviewBridgeServerMessage, Workspace } from "../../src/types";
import { seedTestOwnerUser, testOwnerUser } from "../setup";

function buildWorkspace(id: string, name: string): Workspace {
  const now = new Date().toISOString();
  return {
    id,
    name,
    directory: `/tmp/${id}`,
    serverSettings: {
      agent: {
        provider: "opencode",
        transport: "stdio",
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

function encodeBase64(value: string): string {
  return Buffer.from(new TextEncoder().encode(value)).toString("base64");
}

function decodeBase64(value: string): string {
  return new TextDecoder().decode(Uint8Array.from(Buffer.from(value, "base64")));
}

async function waitForBridgeMessage(
  messages: PreviewBridgeServerMessage[],
  predicate: (message: PreviewBridgeServerMessage) => boolean,
): Promise<PreviewBridgeServerMessage> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const message = messages.find(predicate);
    if (message) {
      return message;
    }
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for bridge message. Last messages: ${JSON.stringify(messages)}`);
}

describe("workspace previews", () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-previews-data-"));
    process.env["CLANKY_DATA_DIR"] = dataDir;
    await ensureDataDirectories();
    await initializeDatabase();
    seedTestOwnerUser();
  });

  afterAll(async () => {
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
    await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    getDatabase().run("DELETE FROM preview_sessions");
    getDatabase().run("DELETE FROM workspaces");
  });

  test("registers, lists, and closes a CLI-owned preview", async () => {
    await runWithCurrentUser(testOwnerUser, async () => {
      await createWorkspace(buildWorkspace("workspace-1", "App"));
      const { preview } = await previewSessionManager.registerCliPreview({
        workspace: "workspace-1",
        remoteHost: "127.0.0.1",
        remotePort: 3000,
        localHost: "127.0.0.1",
        localPort: 43123,
        localUrl: "http://127.0.0.1:43123/",
        initialPath: "dashboard",
        cliHostname: "devbox",
      });

      expect(preview.config.workspaceId).toBe("workspace-1");
      expect(preview.config.initialPath).toBe("/dashboard");
      expect(preview.state.status).toBe("active");

      const previews = await previewSessionManager.listWorkspacePreviews("workspace-1");
      expect(previews).toHaveLength(1);
      expect(previews[0]?.config.localUrl).toBe("http://127.0.0.1:43123/");

      expect(await previewSessionManager.closePreview(preview.config.id, "test close")).toBe(true);
      const closed = await previewSessionManager.getPreview(preview.config.id);
      expect(closed).toBeNull();
      expect(await previewSessionManager.listWorkspacePreviews("workspace-1")).toEqual([]);
    });
  });

  test("does not expose closed previews from workspace or active lists", async () => {
    await runWithCurrentUser(testOwnerUser, async () => {
      await createWorkspace(buildWorkspace("workspace-1", "App"));
      const { preview } = await previewSessionManager.registerCliPreview({
        workspace: "workspace-1",
        remoteHost: "127.0.0.1",
        remotePort: 3000,
        localHost: "127.0.0.1",
        localPort: 43123,
        localUrl: "http://127.0.0.1:43123/",
        initialPath: "/",
        cliHostname: "devbox",
      });

      expect(await previewSessionManager.listActivePreviews()).toHaveLength(1);
      expect(await previewSessionManager.closePreview(preview.config.id, "test close")).toBe(true);
      expect(await previewSessionManager.listActivePreviews()).toEqual([]);
      expect(await previewSessionManager.listWorkspacePreviews("workspace-1")).toEqual([]);
      expect(
        getDatabase().query("SELECT COUNT(*) AS count FROM preview_sessions").get() as { count: number },
      ).toEqual({ count: 0 });
    });
  });

  test("resolves workspace by unique name and rejects ambiguous names", async () => {
    await runWithCurrentUser(testOwnerUser, async () => {
      await createWorkspace(buildWorkspace("workspace-1", "App"));
      await createWorkspace(buildWorkspace("workspace-2", "Duplicate"));
      await createWorkspace(buildWorkspace("workspace-3", "Duplicate"));

      expect((await previewSessionManager.resolveWorkspaceReference("App")).id).toBe("workspace-1");
      await expect(previewSessionManager.resolveWorkspaceReference("Duplicate")).rejects.toThrow("ambiguous");
    });
  });

  test("bridges WebSocket preview streams to the workspace target", async () => {
    const upstreamServer = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          if (server.upgrade(req)) {
            return;
          }
          return new Response("Upgrade failed", { status: 400 });
        }
        return new Response("ok");
      },
      websocket: {
        message(ws, message) {
          ws.send(message);
        },
      },
    });

    try {
      await runWithCurrentUser(testOwnerUser, async () => {
        await createWorkspace(buildWorkspace("workspace-1", "App"));
        const sentMessages: PreviewBridgeServerMessage[] = [];
        const bridgeSocket = {
          data: { user: testOwnerUser },
          send(data: string | Uint8Array) {
            if (typeof data === "string") {
              sentMessages.push(JSON.parse(data) as PreviewBridgeServerMessage);
            }
          },
          close() {},
        };

        await previewSessionManager.handleBridgeMessage(bridgeSocket, JSON.stringify({
          type: "hello",
          workspace: "workspace-1",
          remoteHost: "127.0.0.1",
          remotePort: upstreamServer.port,
          localHost: "127.0.0.1",
          localPort: 43123,
          localUrl: "http://127.0.0.1:43123/",
          initialPath: "/",
          cliHostname: "devbox",
        }));
        const ready = await waitForBridgeMessage(sentMessages, (message) => message.type === "ready");
        expect(ready.type).toBe("ready");

        await previewSessionManager.handleBridgeMessage(bridgeSocket, JSON.stringify({
          type: "websocket.open",
          streamId: "ws-1",
          path: "/socket",
          headers: [],
        }));
        await previewSessionManager.handleBridgeMessage(bridgeSocket, JSON.stringify({
          type: "websocket.message",
          streamId: "ws-1",
          body: encodeBase64("hello"),
          binary: false,
        }));

        const echoed = await waitForBridgeMessage(
          sentMessages,
          (message) => message.type === "websocket.message" && message.streamId === "ws-1",
        );
        if (echoed.type !== "websocket.message") {
          throw new Error(`Expected websocket.message, received ${echoed.type}`);
        }
        expect(echoed.binary).toBe(false);
        expect(decodeBase64(echoed.body)).toBe("hello");

        await previewSessionManager.handleBridgeMessage(bridgeSocket, JSON.stringify({
          type: "websocket.close",
          streamId: "ws-1",
          code: 1000,
          reason: "done",
        }));
        await previewSessionManager.closeBridgeSession(bridgeSocket, "test done");
      });
    } finally {
      upstreamServer.stop(true);
    }
  });

  test("preserves browser Host and Origin for WebSocket preview streams", async () => {
    const previewHost = "127.0.0.1:43123";
    let capturedHeaders: Headers | undefined;
    const upstreamServer = Bun.serve({
      port: 0,
      fetch(req, server) {
        capturedHeaders = req.headers;
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const host = req.headers.get("host");
          const origin = req.headers.get("origin");
          if (!host || origin !== `http://${host}`) {
            return new Response("Request origin is not allowed", { status: 403 });
          }
          if (server.upgrade(req)) {
            return;
          }
          return new Response("Upgrade failed", { status: 400 });
        }
        return new Response("ok");
      },
      websocket: {
        message(ws, message) {
          ws.send(message);
        },
      },
    });

    try {
      await runWithCurrentUser(testOwnerUser, async () => {
        await createWorkspace(buildWorkspace("workspace-1", "App"));
        const sentMessages: PreviewBridgeServerMessage[] = [];
        const bridgeSocket = {
          data: { user: testOwnerUser },
          send(data: string | Uint8Array) {
            if (typeof data === "string") {
              sentMessages.push(JSON.parse(data) as PreviewBridgeServerMessage);
            }
          },
          close() {},
        };

        await previewSessionManager.handleBridgeMessage(bridgeSocket, JSON.stringify({
          type: "hello",
          workspace: "workspace-1",
          remoteHost: "127.0.0.1",
          remotePort: upstreamServer.port,
          localHost: "127.0.0.1",
          localPort: 43123,
          localUrl: `http://${previewHost}/`,
          initialPath: "/",
          cliHostname: "devbox",
        }));
        const ready = await waitForBridgeMessage(sentMessages, (message) => message.type === "ready");
        expect(ready.type).toBe("ready");

        await previewSessionManager.handleBridgeMessage(bridgeSocket, JSON.stringify({
          type: "websocket.open",
          streamId: "same-origin-ws",
          path: "/api/ws",
          headers: [
            ["host", previewHost],
            ["origin", `http://${previewHost}`],
          ],
        }));
        await previewSessionManager.handleBridgeMessage(bridgeSocket, JSON.stringify({
          type: "websocket.message",
          streamId: "same-origin-ws",
          body: encodeBase64("hello"),
          binary: false,
        }));

        const echoed = await waitForBridgeMessage(
          sentMessages,
          (message) => message.type === "websocket.message" && message.streamId === "same-origin-ws",
        );
        if (echoed.type !== "websocket.message") {
          throw new Error(`Expected websocket.message, received ${echoed.type}`);
        }
        expect(decodeBase64(echoed.body)).toBe("hello");
        expect(capturedHeaders?.get("host")).toBe(previewHost);
        expect(capturedHeaders?.get("origin")).toBe(`http://${previewHost}`);
        expect(capturedHeaders?.get("x-forwarded-host")).toBe(previewHost);
        expect(capturedHeaders?.get("x-forwarded-proto")).toBe("http");
        expect(capturedHeaders?.get("x-forwarded-port")).toBe("43123");

        await previewSessionManager.closeBridgeSession(bridgeSocket, "test done");
      });
    } finally {
      upstreamServer.stop(true);
    }
  });

  test("bridges subdirectory preview requests and rewrites target-origin redirects", async () => {
    let upstreamPort = 0;
    const upstreamServer = Bun.serve({
      port: 0,
      fetch(req): Response {
        const url = new URL(req.url);
        if (url.pathname === "/myapp") {
          return new Response(null, {
            status: 308,
            headers: {
              location: `http://127.0.0.1:${String(upstreamPort)}/myapp/`,
            },
          });
        }
        if (url.pathname === "/myapp/assets/app.js") {
          return new Response("console.log('myapp');", {
            headers: {
              "content-type": "text/javascript",
            },
          });
        }
        return new Response(`Unexpected path: ${url.pathname}`, { status: 404 });
      },
    });
    upstreamPort = upstreamServer.port!;

    try {
      await runWithCurrentUser(testOwnerUser, async () => {
        await createWorkspace(buildWorkspace("workspace-1", "App"));
        const sentMessages: PreviewBridgeServerMessage[] = [];
        const bridgeSocket = {
          data: { user: testOwnerUser },
          send(data: string | Uint8Array) {
            if (typeof data === "string") {
              sentMessages.push(JSON.parse(data) as PreviewBridgeServerMessage);
            }
          },
          close() {},
        };

        await previewSessionManager.handleBridgeMessage(bridgeSocket, JSON.stringify({
          type: "hello",
          workspace: "workspace-1",
          remoteHost: "127.0.0.1",
          remotePort: upstreamServer.port,
          localHost: "127.0.0.1",
          localPort: 43123,
          localUrl: "http://127.0.0.1:43123/myapp",
          initialPath: "/myapp",
          cliHostname: "devbox",
        }));
        const ready = await waitForBridgeMessage(sentMessages, (message) => message.type === "ready");
        expect(ready.type).toBe("ready");

        await previewSessionManager.handleBridgeMessage(bridgeSocket, JSON.stringify({
          type: "request.start",
          streamId: "redirect-1",
          method: "GET",
          path: "/myapp",
          headers: [],
        }));
        const redirectStart = await waitForBridgeMessage(
          sentMessages,
          (message) => message.type === "response.start" && message.streamId === "redirect-1",
        );
        if (redirectStart.type !== "response.start") {
          throw new Error(`Expected response.start, received ${redirectStart.type}`);
        }
        expect(redirectStart.status).toBe(308);
        expect(new Headers(redirectStart.headers).get("location")).toBe("http://127.0.0.1:43123/myapp/");

        await previewSessionManager.handleBridgeMessage(bridgeSocket, JSON.stringify({
          type: "request.start",
          streamId: "asset-1",
          method: "GET",
          path: "/myapp/assets/app.js",
          headers: [],
        }));
        const assetStart = await waitForBridgeMessage(
          sentMessages,
          (message) => message.type === "response.start" && message.streamId === "asset-1",
        );
        if (assetStart.type !== "response.start") {
          throw new Error(`Expected response.start, received ${assetStart.type}`);
        }
        expect(assetStart.status).toBe(200);
        const assetBody = await waitForBridgeMessage(
          sentMessages,
          (message) => message.type === "response.body" && message.streamId === "asset-1",
        );
        if (assetBody.type !== "response.body") {
          throw new Error(`Expected response.body, received ${assetBody.type}`);
        }
        expect(decodeBase64(assetBody.body)).toBe("console.log('myapp');");

        await previewSessionManager.closeBridgeSession(bridgeSocket, "test done");
      });
    } finally {
      upstreamServer.stop(true);
    }
  });

  test("falls back to local host and port when CLI preview localUrl is invalid", async () => {
    let upstreamPort = 0;
    const upstreamServer = Bun.serve({
      port: 0,
      fetch(req): Response {
        const url = new URL(req.url);
        return new Response(null, {
          status: 302,
          headers: {
            location: `http://127.0.0.1:${String(upstreamPort)}${url.pathname}`,
          },
        });
      },
    });
    upstreamPort = upstreamServer.port!;

    try {
      await runWithCurrentUser(testOwnerUser, async () => {
        await createWorkspace(buildWorkspace("workspace-1", "App"));

        for (const [index, localUrl] of ["", "not a valid URL"].entries()) {
          const sentMessages: PreviewBridgeServerMessage[] = [];
          const bridgeSocket = {
            data: { user: testOwnerUser },
            send(data: string | Uint8Array) {
              if (typeof data === "string") {
                sentMessages.push(JSON.parse(data) as PreviewBridgeServerMessage);
              }
            },
            close() {},
          };
          const localPort = 43123 + index;

          await previewSessionManager.handleBridgeMessage(bridgeSocket, JSON.stringify({
            type: "hello",
            workspace: "workspace-1",
            remoteHost: "127.0.0.1",
            remotePort: upstreamServer.port,
            localHost: "127.0.0.1",
            localPort,
            localUrl,
            initialPath: "/",
            cliHostname: "devbox",
          }));
          const ready = await waitForBridgeMessage(sentMessages, (message) => message.type === "ready");
          expect(ready.type).toBe("ready");

          await previewSessionManager.handleBridgeMessage(bridgeSocket, JSON.stringify({
            type: "request.start",
            streamId: `redirect-${String(index)}`,
            method: "GET",
            path: "/dashboard",
            headers: [],
          }));
          const redirectStart = await waitForBridgeMessage(
            sentMessages,
            (message) => message.type === "response.start" && message.streamId === `redirect-${String(index)}`,
          );
          if (redirectStart.type !== "response.start") {
            throw new Error(`Expected response.start, received ${redirectStart.type}`);
          }
          expect(redirectStart.status).toBe(302);
          expect(new Headers(redirectStart.headers).get("location")).toBe(`http://127.0.0.1:${String(localPort)}/dashboard`);

          await previewSessionManager.closeBridgeSession(bridgeSocket, "test done");
        }
      });
    } finally {
      upstreamServer.stop(true);
    }
  });
});
