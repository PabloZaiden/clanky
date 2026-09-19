import { afterEach, describe, expect, test } from "bun:test";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import {
  createApiKey,
  createWebAppServer,
  sqliteWebAppStore,
  type UserRecord,
  type RuntimeConfig,
} from "@pablozaiden/webapp/server";
import { rm } from "node:fs/promises";
import { websocketHandlers } from "../../src/api/websocket";
import { runWithCurrentUser } from "../../src/core/user-context";
import { closeDatabase } from "../../src/persistence/database";
import { getPreviewSession } from "../../src/persistence/preview-sessions";
import { routes } from "../../src/server";
import {
  setupTestContext,
  teardownTestContext,
  testOwnerUser,
  type TestContext,
} from "../setup";
import { pollUntil } from "../helpers/polling";

const secondaryUser: CurrentUser = {
  id: "preview-auth-secondary-user",
  username: "preview-auth-secondary-user",
  role: "user",
  isOwner: false,
  isAdmin: false,
};

interface BridgeFrame {
  type?: string;
  error?: string;
  previewId?: string;
}

function createRuntimeConfig(dataDir: string): RuntimeConfig {
  return {
    appName: "Clanky",
    envPrefix: "CLANKY",
    host: "127.0.0.1",
    port: 0,
    dataDir,
    logLevel: "fatal",
    logLevelFromEnv: false,
    inMemoryLogsEnabled: true,
    passkeyDisabled: false,
    sameOriginDisabled: false,
    trustProxy: { enabled: false, headers: [], chain: "first" },
    development: false,
  };
}

function bridgeUrl(baseUrl: string): string {
  const url = new URL("/api/previews/bridge", baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function openAuthenticatedBridge(baseUrl: string, token: string): WebSocket {
  const BunWebSocket = WebSocket as unknown as {
    new (url: string, options?: Bun.WebSocketOptions): WebSocket;
  };
  return new BunWebSocket(bridgeUrl(baseUrl), {
    headers: {
      ["authorization"]: "Bearer " + token,
      origin: baseUrl,
    },
  });
}

async function waitForOpen(socket: WebSocket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onOpen = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("Authenticated preview bridge WebSocket failed to open"));
    };
    const cleanup = (): void => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
    };
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
  });
}

async function waitForFrame(
  socket: WebSocket,
  predicate: (frame: BridgeFrame) => boolean,
): Promise<BridgeFrame> {
  return await new Promise<BridgeFrame>((resolve, reject) => {
    const onMessage = (event: MessageEvent): void => {
      if (typeof event.data !== "string") {
        return;
      }
      let frame: BridgeFrame;
      try {
        frame = JSON.parse(event.data) as BridgeFrame;
      } catch (error) {
        cleanup();
        reject(new Error("Preview bridge returned invalid JSON", { cause: error }));
        return;
      }
      if (!predicate(frame)) {
        return;
      }
      cleanup();
      resolve(frame);
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("Authenticated preview bridge WebSocket failed"));
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("Authenticated preview bridge WebSocket closed before the expected frame"));
    };
    const cleanup = (): void => {
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
    };
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
  });
}

async function waitForClose(socket: WebSocket): Promise<CloseEvent> {
  return await new Promise<CloseEvent>((resolve, reject) => {
    const onClose = (event: Event): void => {
      cleanup();
      resolve(event as CloseEvent);
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("Authenticated preview bridge WebSocket errored before closing"));
    };
    const cleanup = (): void => {
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("error", onError);
    };
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onError);
  });
}

describe("authenticated preview bridge", () => {
  let context: TestContext | undefined;
  let dataDir: string | undefined;
  let appServer: Awaited<ReturnType<ReturnType<typeof createWebAppServer>["start"]>> | undefined;

  afterEach(async () => {
    if (appServer) {
      await appServer.stop(true);
      appServer = undefined;
    }
    if (context) {
      await teardownTestContext(context);
      context = undefined;
    } else {
      closeDatabase();
    }
    if (dataDir) {
      await rm(dataDir, { recursive: true, force: true });
      dataDir = undefined;
    }
    delete process.env["CLANKY_DATA_DIR"];
  });

  test("rejects a second authenticated user from another user's preview target", async () => {
    context = await setupTestContext();
    dataDir = context.dataDir;

    const store = sqliteWebAppStore({ dataDir });
    const app = createWebAppServer({
      appName: "Clanky",
      envPrefix: "CLANKY",
      appDirectoryName: ".clanky",
      runtimeConfig: createRuntimeConfig(dataDir),
      web: false,
      store,
      auth: { passkeys: true, apiKeys: true, deviceAuth: false },
      routes,
      websockets: {
        clanky: websocketHandlers as never,
      },
    });
    appServer = await app.start();

    const now = new Date().toISOString();
    for (const user of [testOwnerUser, secondaryUser]) {
      if (!store.getUserById(user.id)) {
        store.createUser({
          ...user,
          authVersion: 1,
          passkeyConfigured: false,
          createdAt: now,
          updatedAt: now,
        } satisfies UserRecord);
      }
    }
    const ownerKey = createApiKey(store, testOwnerUser, {
      name: "owner preview bridge",
      scopes: ["*"],
    });
    const secondaryKey = createApiKey(store, secondaryUser, {
      name: "secondary preview bridge",
      scopes: ["*"],
    });
    const baseUrl = appServer.url.toString().replace(/\/$/, "");
    const ownerSocket = openAuthenticatedBridge(baseUrl, ownerKey.token);
    const secondarySocket = openAuthenticatedBridge(baseUrl, secondaryKey.token);
    let ownerPreviewId: string | undefined;

    try {
      await Promise.all([waitForOpen(ownerSocket), waitForOpen(secondarySocket)]);
      await Promise.all([
        waitForFrame(ownerSocket, (frame) => frame.type === "connected"),
        waitForFrame(secondarySocket, (frame) => frame.type === "connected"),
      ]);

      const hello = {
        type: "hello",
        target: { kind: "workspace", reference: "test-workspace-id" },
        remoteHost: "127.0.0.1",
        remotePort: 43123,
        localHost: "127.0.0.1",
        localPort: 43123,
        localUrl: "http://127.0.0.1:43123/",
        initialPath: "/",
        cliHostname: "owner-cli",
      };
      ownerSocket.send(JSON.stringify(hello));
      const ownerReady = await waitForFrame(ownerSocket, (frame) => frame.type === "ready");
      expect(ownerReady.previewId).toBeString();
      ownerPreviewId = ownerReady.previewId;

      const ownerPreview = await runWithCurrentUser(
        testOwnerUser,
        () => getPreviewSession(ownerReady.previewId!),
      );
      expect(ownerPreview).not.toBeNull();

      const secondaryClosed = waitForClose(secondarySocket);
      secondarySocket.send(JSON.stringify(hello));
      const secondaryFrames: BridgeFrame[] = [];
      const secondaryError = await waitForFrame(
        secondarySocket,
        (frame) => {
          secondaryFrames.push(frame);
          return frame.type === "stream.error";
        },
      );
      expect(secondaryFrames.some((frame) => frame.type === "ready")).toBe(false);
      expect(secondaryError.error).toContain("Workspace not found");
      const secondaryClose = await secondaryClosed;
      expect(secondaryClose.code).toBe(1011);

      const ownerPreviewAfterAttempt = await runWithCurrentUser(
        testOwnerUser,
        () => getPreviewSession(ownerReady.previewId!),
      );
      expect(ownerPreviewAfterAttempt).not.toBeNull();
    } finally {
      const ownerClosed = waitForClose(ownerSocket).catch(() => undefined);
      ownerSocket.close(1000, "test complete");
      await ownerClosed;
      if (ownerPreviewId) {
        await pollUntil(
          async () => await runWithCurrentUser(
            testOwnerUser,
            async () => await getPreviewSession(ownerPreviewId!),
          ),
          (preview) => preview === null,
          {
            description: "owner preview cleanup",
            timeoutMs: 5000,
            formatLastObserved: (preview) => preview?.config.id ?? "closed",
          },
        );
      }
    }
  });
});
