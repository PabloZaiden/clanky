import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, getDatabase, initializeDatabase } from "../../src/persistence/database";
import { createWorkspace } from "../../src/persistence/workspaces";
import { deleteSshServer, saveSshServerConfig } from "../../src/persistence/ssh-servers";
import { previewSessionManager } from "../../src/core/preview-session-manager";
import { runWithCurrentUser } from "../../src/context/user-context";
import {
  getExecutionHostSourceId,
  POSIX_EXECUTION_HOST_CAPABILITIES,
  type ExecutionHostBinding,
  type PreviewBridgeServerMessage,
  type Workspace,
} from "@/shared";
import { ensureExecutionHost, toExecutionHostBinding } from "../../src/persistence/execution-hosts";
import { PreviewSessionManager } from "../../src/core/preview-session-manager";
import { buildMeshTargetKey } from "../../src/persistence/workspace-target-key";
import {
  getTestLocalExecutionHostBinding,
  seedTestOwnerUser,
  testOwnerUser,
} from "../setup";
import { pollUntil } from "../helpers/polling";

function buildWorkspace(
  id: string,
  name: string,
  executionHostBinding: ExecutionHostBinding,
): Workspace {
  const now = new Date().toISOString();
  return {
    id,
    name,
    directory: `/tmp/${id}`,
    workspaceType: "git",
    executionTargetRevision: 1,
    executionHostBinding,
    serverSettings: {
      agent: {
        provider: "opencode",
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

const secondaryUser: CurrentUser = {
  id: "preview-secondary-user",
  username: "preview-secondary-user",
  role: "user",
  isOwner: false,
  isAdmin: false,
};

function seedUser(user: CurrentUser): void {
  const now = new Date().toISOString();
  getDatabase()
    .query(`
      INSERT OR IGNORE INTO webapp_users (
        id, username, role, auth_version, created_at, updated_at, last_login_at, disabled_at
      ) VALUES (?, ?, ?, 1, ?, ?, NULL, NULL)
    `)
    .run(user.id, user.username, user.role, now, now);
}

function createBridgeSocket(user: CurrentUser): {
  socket: {
    data: {
      previewBridgeSessionId?: string;
      previewBridgeUserId?: string;
      user: CurrentUser;
    };
    send(data: string | Uint8Array): void;
    close(): void;
  };
  messages: PreviewBridgeServerMessage[];
} {
  const messages: PreviewBridgeServerMessage[] = [];
  return {
    socket: {
      data: {
        user,
        previewBridgeUserId: user.id,
      },
      send(data: string | Uint8Array) {
        if (typeof data === "string") {
          messages.push(JSON.parse(data) as PreviewBridgeServerMessage);
        }
      },
      close() {},
    },
    messages,
  };
}

async function waitForBridgeMessage(
  messages: PreviewBridgeServerMessage[],
  predicate: (message: PreviewBridgeServerMessage) => boolean,
): Promise<PreviewBridgeServerMessage> {
  return pollUntil(
    () => messages.find(predicate),
    (message): message is PreviewBridgeServerMessage => message !== undefined,
    {
      description: "a preview bridge message",
      timeoutMs: 5000,
      formatLastObserved: (message) => message === undefined
        ? "none"
        : JSON.stringify(message) ?? "unserializable message",
    },
  );
}

describe("workspace previews", () => {
  let dataDir: string;
  let executionHostBinding: ExecutionHostBinding;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-previews-data-"));
    process.env["CLANKY_DATA_DIR"] = dataDir;
    await initializeDatabase();
    seedTestOwnerUser();
    seedUser(secondaryUser);
    executionHostBinding = await runWithCurrentUser(
      testOwnerUser,
      getTestLocalExecutionHostBinding,
    );
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

  test("registers a direct Mesh server preview through the bridge", async () => {
    const meshNodeId = "preview-mesh-worker";
    const meshRef = { kind: "mesh", nodeId: meshNodeId } as const;
    const now = new Date().toISOString();
    getDatabase().query(`
      INSERT INTO mesh_worker_registrations (
        worker_node_id, local_user_id, worker_instance_name,
        worker_endpoint, worker_transport,
        worker_public_key, worker_fingerprint,
        worker_encryption_public_key,
        route_kind, worker_directory,
        worker_platform_os, worker_platform_architecture,
        worker_capabilities_json, worker_accept_remote_execution,
        worker_config_revision, registration_scope, grant_status,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      meshNodeId,
      testOwnerUser.id,
      "Preview Mesh worker",
      "http://127.0.0.1:1",
      "http",
      "fixture-public-key",
      "fixture-fingerprint",
      "fixture-encryption-key",
      "direct",
      null,
      "linux",
      "x64",
      JSON.stringify(POSIX_EXECUTION_HOST_CAPABILITIES),
      1,
      1,
      "global",
      "active",
      now,
      now,
    );
    const meshBinding = await runWithCurrentUser(testOwnerUser, async () =>
      toExecutionHostBinding(ensureExecutionHost(
        testOwnerUser.id,
        meshRef,
        buildMeshTargetKey(meshNodeId),
        {
          runtime: {
            platform: { os: "linux", architecture: "x64" },
            capabilities: POSIX_EXECUTION_HOST_CAPABILITIES,
          },
        },
      ))
    );
    let openedBinding: ExecutionHostBinding | undefined;
    let openedRemotePort: number | undefined;
    let closeCount = 0;
    const manager = new PreviewSessionManager({
      openPreviewTcpForward: async (binding, remotePort) => {
        openedBinding = binding;
        openedRemotePort = remotePort;
        return {
          localPort: 45454,
          close: async () => {
            closeCount += 1;
          },
        };
      },
    });

    await runWithCurrentUser(testOwnerUser, async () => {
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

      await manager.handleBridgeMessage(bridgeSocket, JSON.stringify({
        type: "hello",
        target: {
          kind: "server",
          reference: meshNodeId,
        },
        remoteHost: "127.0.0.1",
        remotePort: 4173,
        localHost: "127.0.0.1",
        localPort: 54173,
        localUrl: "http://127.0.0.1:54173/",
        initialPath: "/",
        cliHostname: "mesh-devbox",
      }));

      const ready = await waitForBridgeMessage(
        sentMessages,
        (message) => message.type === "ready",
      );
      expect(ready.type).toBe("ready");
      if (ready.type !== "ready") {
        throw new Error(`Expected ready message, received ${ready.type}`);
      }
      expect(ready.targetKind).toBe("server");
      expect(ready.workspaceId).toBeUndefined();
      expect(openedBinding).toEqual(meshBinding);
      expect(openedRemotePort).toBe(4173);

      const preview = await manager.getPreview(ready.previewId);
      expect(preview?.config.executionHostBinding).toEqual(meshBinding);
      expect(preview?.config.workspaceId).toBeUndefined();

      await manager.closeBridgeSession(bridgeSocket, "test done");
      expect(closeCount).toBe(1);
      expect(await manager.getPreview(ready.previewId)).toBeNull();
    });
  });

  test("forwards HTTP requests for a direct local server target", async () => {
    const upstreamServer = Bun.serve({
      port: 0,
      fetch() {
        return new Response("direct server response");
      },
    });

    try {
      await runWithCurrentUser(testOwnerUser, async () => {
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
          target: {
            kind: "server",
            reference: getExecutionHostSourceId(executionHostBinding.host),
          },
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
        if (ready.type === "ready") {
          expect(ready.targetKind).toBe("server");
          expect(ready.workspaceId).toBeUndefined();
        }

        await previewSessionManager.handleBridgeMessage(bridgeSocket, JSON.stringify({
          type: "request.start",
          streamId: "direct-request",
          method: "GET",
          path: "/health",
          headers: [],
        }));
        const responseStart = await waitForBridgeMessage(
          sentMessages,
          (message) => message.type === "response.start" && message.streamId === "direct-request",
        );
        if (responseStart.type !== "response.start") {
          throw new Error(`Expected response.start, received ${responseStart.type}`);
        }
        expect(responseStart.status).toBe(200);
        const responseBody = await waitForBridgeMessage(
          sentMessages,
          (message) => message.type === "response.body" && message.streamId === "direct-request",
        );
        if (responseBody.type !== "response.body") {
          throw new Error(`Expected response.body, received ${responseBody.type}`);
        }
        expect(decodeBase64(responseBody.body)).toBe("direct server response");

        await previewSessionManager.closeBridgeSession(bridgeSocket, "test done");
      });
    } finally {
      upstreamServer.stop(true);
    }
  });

  test("rejects cross-origin HTTP bridge paths before opening upstream requests", async () => {
    let allowedRequests = 0;
    let blockedRequests = 0;
    const blockedServer = Bun.serve({
      port: 0,
      fetch() {
        blockedRequests += 1;
        return new Response("blocked server reached", { status: 500 });
      },
    });
    const allowedServer = Bun.serve({
      port: 0,
      fetch() {
        allowedRequests += 1;
        return new Response("allowed server reached");
      },
    });
    const { socket: bridgeSocket, messages: sentMessages } = createBridgeSocket(testOwnerUser);

    try {
      await runWithCurrentUser(testOwnerUser, async () => {
        await previewSessionManager.handleBridgeMessage(bridgeSocket, JSON.stringify({
          type: "hello",
          target: {
            kind: "server",
            reference: getExecutionHostSourceId(executionHostBinding.host),
          },
          remoteHost: "127.0.0.1",
          remotePort: allowedServer.port,
          localHost: "127.0.0.1",
          localPort: 43123,
          localUrl: "http://127.0.0.1:43123/",
          initialPath: "/",
          cliHostname: "devbox",
        }));
        const ready = await waitForBridgeMessage(sentMessages, (message) => message.type === "ready");
        expect(ready.type).toBe("ready");

        const invalidPaths = [
          `http://127.0.0.1:${String(blockedServer.port)}/absolute`,
          `//127.0.0.1:${String(blockedServer.port)}/scheme-relative`,
          "ftp://127.0.0.1:21/alternate-scheme",
          "http://user:password@127.0.0.1/credentials",
          "//[",
          "/\\escaped-authority",
        ];
        for (const [index, path] of invalidPaths.entries()) {
          const streamId = `invalid-http-${String(index)}`;
          await previewSessionManager.handleBridgeMessage(bridgeSocket, JSON.stringify({
            type: "request.start",
            streamId,
            method: "GET",
            path,
            headers: [],
          }));
          const rejection = await waitForBridgeMessage(
            sentMessages,
            (message) => message.type === "stream.error" && message.streamId === streamId,
          );
          if (rejection.type !== "stream.error") {
            throw new Error(`Expected stream.error, received ${rejection.type}`);
          }
          expect(rejection.error).toBe("Preview destination rejected");
        }

        await previewSessionManager.closeBridgeSession(bridgeSocket, "test done");
      });

      expect(allowedRequests).toBe(0);
      expect(blockedRequests).toBe(0);
    } finally {
      if (bridgeSocket.data.previewBridgeSessionId) {
        await runWithCurrentUser(testOwnerUser, async () => {
          await previewSessionManager.closeBridgeSession(bridgeSocket, "test cleanup");
        });
      }
      allowedServer.stop(true);
      blockedServer.stop(true);
    }
  });

  test("rejects direct SSH previews before creating a transport", async () => {
    const serverId = "ssh-preview-server";
    await runWithCurrentUser(testOwnerUser, async () => {
      await saveSshServerConfig({
        id: serverId,
        name: "SSH preview server",
        address: "127.0.0.1",
        port: 22,
        username: "preview",
        repositoriesBasePath: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isPrivate: false,
      });
      try {
        await expect(previewSessionManager.registerCliPreview({
          target: { kind: "server", reference: serverId },
          remoteHost: "127.0.0.1",
          remotePort: 3000,
          localHost: "127.0.0.1",
          localPort: 43123,
          localUrl: "http://127.0.0.1:43123/",
          initialPath: "/",
        })).rejects.toThrow("Direct previews are not supported for SSH servers");
        expect(await previewSessionManager.listActivePreviews()).toEqual([]);
      } finally {
        await deleteSshServer(serverId);
      }
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
        await createWorkspace(buildWorkspace("workspace-1", "App", executionHostBinding));
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
          target: { kind: "workspace", reference: "workspace-1" },
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
    const previewHost = "preview.example.test";
    const previewOrigin = `https://${previewHost}`;
    let capturedHeaders: Headers | undefined;
    const upstreamServer = Bun.serve({
      port: 0,
      fetch(req, server) {
        capturedHeaders = req.headers;
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          const host = req.headers.get("host");
          const origin = req.headers.get("origin");
          if (!host || origin !== previewOrigin) {
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
        await createWorkspace(buildWorkspace("workspace-1", "App", executionHostBinding));
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
          target: { kind: "workspace", reference: "workspace-1" },
          remoteHost: "127.0.0.1",
          remotePort: upstreamServer.port,
          localHost: "127.0.0.1",
          localPort: 43123,
          localUrl: `${previewOrigin}/`,
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
            ["origin", previewOrigin],
            ["x-forwarded-host", "attacker.example.test"],
            ["x-forwarded-proto", "http"],
            ["x-forwarded-port", "80"],
            ["forwarded", "host=attacker.example.test"],
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
        expect(capturedHeaders?.get("origin")).toBe(previewOrigin);
        expect(capturedHeaders?.get("x-forwarded-host")).toBe(previewHost);
        expect(capturedHeaders?.get("x-forwarded-proto")).toBe("https");
        expect(capturedHeaders?.get("x-forwarded-port")).toBe("443");

        await previewSessionManager.closeBridgeSession(bridgeSocket, "test done");
      });
    } finally {
      upstreamServer.stop(true);
    }
  });

  test("rejects cross-origin WebSocket paths before opening upstream sockets", async () => {
    let blockedWebSocketRequests = 0;
    const blockedServer = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          blockedWebSocketRequests += 1;
          if (server.upgrade(req)) {
            return;
          }
          return new Response("Upgrade failed", { status: 400 });
        }
        return new Response("blocked server reached", { status: 500 });
      },
      websocket: {
        message() {},
      },
    });
    const allowedServer = Bun.serve({
      port: 0,
      fetch() {
        return new Response("allowed server reached");
      },
    });
    const { socket: bridgeSocket, messages: sentMessages } = createBridgeSocket(testOwnerUser);

    try {
      await runWithCurrentUser(testOwnerUser, async () => {
        await previewSessionManager.handleBridgeMessage(bridgeSocket, JSON.stringify({
          type: "hello",
          target: {
            kind: "server",
            reference: getExecutionHostSourceId(executionHostBinding.host),
          },
          remoteHost: "127.0.0.1",
          remotePort: allowedServer.port,
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
          streamId: "invalid-websocket",
          path: `ws://127.0.0.1:${String(blockedServer.port)}/socket`,
          headers: [],
        }));
        const rejection = await waitForBridgeMessage(
          sentMessages,
          (message) => message.type === "stream.error" && message.streamId === "invalid-websocket",
        );
        if (rejection.type !== "stream.error") {
          throw new Error(`Expected stream.error, received ${rejection.type}`);
        }
        expect(rejection.error).toBe("Preview destination rejected");
        expect(blockedWebSocketRequests).toBe(0);

        await previewSessionManager.closeBridgeSession(bridgeSocket, "test done");
      });
    } finally {
      if (bridgeSocket.data.previewBridgeSessionId) {
        await runWithCurrentUser(testOwnerUser, async () => {
          await previewSessionManager.closeBridgeSession(bridgeSocket, "test cleanup");
        });
      }
      allowedServer.stop(true);
      blockedServer.stop(true);
    }
  });

  test("does not follow or localize external redirects", async () => {
    let externalRequests = 0;
    const externalServer = Bun.serve({
      port: 0,
      fetch() {
        externalRequests += 1;
        return new Response("external server reached");
      },
    });
    const externalLocation = `http://127.0.0.1:${String(externalServer.port)}/external-target`;
    const upstreamServer = Bun.serve({
      port: 0,
      fetch(req): Response {
        if (new URL(req.url).pathname === "/external-redirect") {
          return new Response(null, {
            status: 302,
            headers: { location: externalLocation },
          });
        }
        return new Response("upstream response");
      },
    });
    const { socket: bridgeSocket, messages: sentMessages } = createBridgeSocket(testOwnerUser);

    try {
      await runWithCurrentUser(testOwnerUser, async () => {
        await previewSessionManager.handleBridgeMessage(bridgeSocket, JSON.stringify({
          type: "hello",
          target: {
            kind: "server",
            reference: getExecutionHostSourceId(executionHostBinding.host),
          },
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
          type: "request.start",
          streamId: "external-redirect",
          method: "GET",
          path: "/external-redirect",
          headers: [],
        }));
        const responseStart = await waitForBridgeMessage(
          sentMessages,
          (message) => message.type === "response.start" && message.streamId === "external-redirect",
        );
        if (responseStart.type !== "response.start") {
          throw new Error(`Expected response.start, received ${responseStart.type}`);
        }
        expect(responseStart.status).toBe(302);
        expect(new Headers(responseStart.headers).get("location")).toBe(externalLocation);
        await waitForBridgeMessage(
          sentMessages,
          (message) => message.type === "response.end" && message.streamId === "external-redirect",
        );
        expect(externalRequests).toBe(0);

        await previewSessionManager.closeBridgeSession(bridgeSocket, "test done");
      });
    } finally {
      if (bridgeSocket.data.previewBridgeSessionId) {
        await runWithCurrentUser(testOwnerUser, async () => {
          await previewSessionManager.closeBridgeSession(bridgeSocket, "test cleanup");
        });
      }
      upstreamServer.stop(true);
      externalServer.stop(true);
    }
  });

  test("does not allow another user to use an active preview bridge", async () => {
    let upstreamRequests = 0;
    const upstreamServer = Bun.serve({
      port: 0,
      fetch() {
        upstreamRequests += 1;
        return new Response("owner response");
      },
    });
    const {
      socket: ownerBridgeSocket,
      messages: ownerMessages,
    } = createBridgeSocket(testOwnerUser);
    const {
      socket: otherBridgeSocket,
      messages: otherMessages,
    } = createBridgeSocket(secondaryUser);

    try {
      await runWithCurrentUser(testOwnerUser, async () => {
        await previewSessionManager.handleBridgeMessage(ownerBridgeSocket, JSON.stringify({
          type: "hello",
          target: {
            kind: "server",
            reference: getExecutionHostSourceId(executionHostBinding.host),
          },
          remoteHost: "127.0.0.1",
          remotePort: upstreamServer.port,
          localHost: "127.0.0.1",
          localPort: 43123,
          localUrl: "http://127.0.0.1:43123/",
          initialPath: "/",
          cliHostname: "owner-devbox",
        }));
        const ready = await waitForBridgeMessage(ownerMessages, (message) => message.type === "ready");
        expect(ready.type).toBe("ready");
        if (ready.type !== "ready") {
          throw new Error(`Expected ready message, received ${ready.type}`);
        }
        otherBridgeSocket.data.previewBridgeSessionId = ready.previewId;
      });

      await runWithCurrentUser(secondaryUser, async () => {
        await previewSessionManager.handleBridgeMessage(otherBridgeSocket, JSON.stringify({
          type: "request.start",
          streamId: "cross-user-http",
          method: "GET",
          path: "/health",
          headers: [],
        }));
        const httpRejection = await waitForBridgeMessage(
          otherMessages,
          (message) => message.type === "stream.error" && message.streamId === "cross-user-http",
        );
        if (httpRejection.type !== "stream.error") {
          throw new Error(`Expected stream.error, received ${httpRejection.type}`);
        }
        expect(httpRejection.error).toBe("Preview runtime is not available");

        await previewSessionManager.handleBridgeMessage(otherBridgeSocket, JSON.stringify({
          type: "websocket.open",
          streamId: "cross-user-websocket",
          path: "/socket",
          headers: [],
        }));
        const websocketRejection = await waitForBridgeMessage(
          otherMessages,
          (message) => message.type === "stream.error" && message.streamId === "cross-user-websocket",
        );
        if (websocketRejection.type !== "stream.error") {
          throw new Error(`Expected stream.error, received ${websocketRejection.type}`);
        }
        expect(websocketRejection.error).toBe("Preview runtime is not available");

        await previewSessionManager.closeBridgeSession(otherBridgeSocket, "cross-user close");
      });

      expect(ownerBridgeSocket.data.previewBridgeSessionId).toBeDefined();
      await runWithCurrentUser(testOwnerUser, async () => {
        await previewSessionManager.handleBridgeMessage(ownerBridgeSocket, JSON.stringify({
          type: "request.start",
          streamId: "owner-http",
          method: "GET",
          path: "/health",
          headers: [],
        }));
        const responseStart = await waitForBridgeMessage(
          ownerMessages,
          (message) => message.type === "response.start" && message.streamId === "owner-http",
        );
        if (responseStart.type !== "response.start") {
          throw new Error(`Expected response.start, received ${responseStart.type}`);
        }
        expect(responseStart.status).toBe(200);
        await waitForBridgeMessage(
          ownerMessages,
          (message) => message.type === "response.end" && message.streamId === "owner-http",
        );
        await previewSessionManager.closeBridgeSession(ownerBridgeSocket, "test done");
      });
      expect(upstreamRequests).toBe(1);
    } finally {
      if (ownerBridgeSocket.data.previewBridgeSessionId) {
        await runWithCurrentUser(testOwnerUser, async () => {
          await previewSessionManager.closeBridgeSession(ownerBridgeSocket, "test cleanup");
        });
      }
      upstreamServer.stop(true);
    }
  });

  test("prevents new upstream streams after a preview is closed", async () => {
    let httpRequests = 0;
    let websocketRequests = 0;
    const upstreamServer = Bun.serve({
      port: 0,
      fetch(req, server) {
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          websocketRequests += 1;
          if (server.upgrade(req)) {
            return;
          }
          return new Response("Upgrade failed", { status: 400 });
        }
        httpRequests += 1;
        return new Response("should not be reached");
      },
      websocket: {
        message() {},
      },
    });
    const { socket: bridgeSocket, messages: sentMessages } = createBridgeSocket(testOwnerUser);

    try {
      await runWithCurrentUser(testOwnerUser, async () => {
        await previewSessionManager.handleBridgeMessage(bridgeSocket, JSON.stringify({
          type: "hello",
          target: {
            kind: "server",
            reference: getExecutionHostSourceId(executionHostBinding.host),
          },
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
        if (ready.type !== "ready") {
          throw new Error(`Expected ready message, received ${ready.type}`);
        }

        await previewSessionManager.closePreview(ready.previewId, "test close");
        expect(bridgeSocket.data.previewBridgeSessionId).toBeUndefined();

        await previewSessionManager.handleBridgeMessage(bridgeSocket, JSON.stringify({
          type: "request.start",
          streamId: "closed-http",
          method: "GET",
          path: "/health",
          headers: [],
        }));
        const httpRejection = await waitForBridgeMessage(
          sentMessages,
          (message) => message.type === "stream.error" && message.streamId === "closed-http",
        );
        if (httpRejection.type !== "stream.error") {
          throw new Error(`Expected stream.error, received ${httpRejection.type}`);
        }
        expect(httpRejection.error).toBe("Preview bridge is not ready");

        await previewSessionManager.handleBridgeMessage(bridgeSocket, JSON.stringify({
          type: "websocket.open",
          streamId: "closed-websocket",
          path: "/socket",
          headers: [],
        }));
        const websocketRejection = await waitForBridgeMessage(
          sentMessages,
          (message) => message.type === "stream.error" && message.streamId === "closed-websocket",
        );
        if (websocketRejection.type !== "stream.error") {
          throw new Error(`Expected stream.error, received ${websocketRejection.type}`);
        }
        expect(websocketRejection.error).toBe("Preview bridge is not ready");
      });

      expect(httpRequests).toBe(0);
      expect(websocketRequests).toBe(0);
    } finally {
      if (bridgeSocket.data.previewBridgeSessionId) {
        await runWithCurrentUser(testOwnerUser, async () => {
          await previewSessionManager.closeBridgeSession(bridgeSocket, "test cleanup");
        });
      }
      upstreamServer.stop(true);
    }
  });

});
