/**
 * Headless webapp server adapter for the transport-only Mesh relay.
 */

import type {
  Server,
  ServerWebSocket,
  WebSocketHandler,
} from "bun";
import {
  createLogger,
  createWebAppServer,
  defineRoutes,
  readRuntimeConfig,
  sqliteWebAppStore,
  webAppConfigPath,
  type RuntimeConfig,
  type WebAppServer,
  type WebAppWebSocketData,
} from "@pablozaiden/webapp/server";
import {
  MESH_RELAY_ENROLLMENT_PROTOCOL_VERSION,
  MESH_RELAY_CONTROL_PATH,
  MESH_RELAY_DESCRIPTOR_PATH,
  MESH_RELAY_PROTOCOL_VERSION,
  MESH_RELAY_STREAM_PATH,
  type MeshRelayWellKnownDescriptor,
  type MeshRelayWellKnownDescriptorV5,
} from "@/shared/mesh-relay";
import {
  MESH_LEGACY_PROTOCOL_VERSION,
  MESH_PROTOCOL_VERSION,
  MESH_PROTOCOL_VERSION_HEADER,
  MESH_PROTOCOL_VERSIONS_HEADER,
  MESH_SUPPORTED_PROTOCOL_VERSIONS,
  negotiateMeshProtocolVersion,
  parseMeshProtocolVersionsHeader,
  serializeMeshProtocolVersions,
} from "@/shared/mesh-protocol";
import { CLANKY_VERSION } from "../version";
import {
  MeshRelayBroker,
  RELAY_MAX_DATA_FRAME_BYTES,
  RELAY_MAX_QUEUED_BYTES,
  type MeshRelaySocket,
} from "./mesh-relay-broker";
import {
  ensureMeshRelayIdentity,
  type MeshRelaySigningIdentity,
} from "./mesh-relay-identity";
import { MeshRelayStore } from "./mesh-relay-store";

const log = createLogger("core:mesh-relay-server");
const RELAY_WEBSOCKET_HANDLER = "meshRelay";

export interface MeshRelayWebSocketData extends WebAppWebSocketData {
  webappSocketHandler: typeof RELAY_WEBSOCKET_HANDLER;
  relaySocketKind: "control" | "data";
  relayControlConnectionId?: string;
  relayDataReservationId?: string;
  relayProtocolVersion?: 2 | typeof MESH_PROTOCOL_VERSION;
}

export interface CreateRelayServerOptions {
  dataDir?: string;
  controllerFingerprint?: string;
  runtimeConfig?: RuntimeConfig;
  version?: string;
}

export interface RelayServer {
  app: WebAppServer;
  broker: MeshRelayBroker;
  identity: MeshRelaySigningIdentity;
  store: MeshRelayStore;
  descriptor: MeshRelayWellKnownDescriptor | MeshRelayWellKnownDescriptorV5;
  start(): Promise<Server<WebAppWebSocketData>>;
  stop(closeActiveConnections?: boolean): Promise<void>;
}

export interface StartedRelayServer extends RelayServer {
  server: Server<WebAppWebSocketData>;
}

function requireControllerFingerprint(value: string | undefined): string {
  const fingerprint = value?.trim();
  if (!fingerprint) {
    throw new Error("CLANKY_RELAY_CONTROLLER_FINGERPRINT is required.");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(fingerprint)) {
    throw new Error(
      "CLANKY_RELAY_CONTROLLER_FINGERPRINT must be a sha256 Mesh fingerprint.",
    );
  }
  return fingerprint;
}

function resolveRelayRuntimeConfig(
  options: CreateRelayServerOptions,
): RuntimeConfig {
  const base = options.runtimeConfig ?? readRuntimeConfig({
    appName: "Clanky Relay",
    envPrefix: "CLANKY",
    appDirectoryName: ".clanky",
  });
  if (
    base.appName !== "Clanky Relay"
    || base.envPrefix !== "CLANKY"
  ) {
    throw new Error(
      "Relay runtimeConfig must use appName \"Clanky Relay\" and envPrefix \"CLANKY\".",
    );
  }
  if (!options.dataDir || options.dataDir === base.dataDir) {
    return base;
  }
  return {
    ...base,
    dataDir: options.dataDir,
    configPath: webAppConfigPath(options.dataDir),
  };
}

function isWebSocketUpgrade(req: Request): boolean {
  return req.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function hasNoQuery(url: URL): boolean {
  return url.search.length === 0;
}

function hasValidControlQuery(url: URL): boolean {
  const keys = [...url.searchParams.keys()];
  if (keys.length === 0) {
    return true;
  }
  return keys.length === 1
    && keys[0] === "protocolVersion"
    && url.searchParams.getAll("protocolVersion").length === 1
    && (
      url.searchParams.get("protocolVersion") === String(MESH_RELAY_PROTOCOL_VERSION)
      || url.searchParams.get("protocolVersion") === String(MESH_PROTOCOL_VERSION)
    );
}

function hasValidStreamQuery(url: URL): boolean {
  const keys = [...url.searchParams.keys()];
  return keys.length === 2
    && keys.includes("ticket")
    && keys.includes("credential")
    && url.searchParams.getAll("ticket").length === 1
    && url.searchParams.getAll("credential").length === 1
    && Boolean(url.searchParams.get("ticket"))
    && Boolean(url.searchParams.get("credential"));
}

function relayRequestFilter(req: Request): boolean {
  const url = new URL(req.url);
  if (req.method !== "GET") {
    return false;
  }
  if (
    url.pathname === "/api/health"
    || url.pathname === MESH_RELAY_DESCRIPTOR_PATH
  ) {
    return hasNoQuery(url);
  }
  if (url.pathname === MESH_RELAY_CONTROL_PATH) {
    return hasValidControlQuery(url) && isWebSocketUpgrade(req);
  }
  if (url.pathname === MESH_RELAY_STREAM_PATH) {
    return isWebSocketUpgrade(req) && hasValidStreamQuery(url);
  }
  return false;
}

function relaySocket(
  socket: ServerWebSocket<MeshRelayWebSocketData>,
): MeshRelaySocket {
  return {
    send(data): number {
      return socket.send(data);
    },
    close(code, reason): void {
      socket.close(code, reason);
    },
    getBufferedAmount(): number {
      return socket.getBufferedAmount();
    },
  };
}

function upgradeServer(
  server: Server<unknown> | undefined,
): Server<MeshRelayWebSocketData> | undefined {
  return server as Server<MeshRelayWebSocketData> | undefined;
}

function createRelayWebSocketHandler(
  broker: MeshRelayBroker,
): Partial<WebSocketHandler<WebAppWebSocketData>> {
  return {
    maxPayloadLength: RELAY_MAX_DATA_FRAME_BYTES,
    backpressureLimit: RELAY_MAX_QUEUED_BYTES,
    closeOnBackpressureLimit: true,
    idleTimeout: 60,
    open(rawSocket): void {
      const socket = rawSocket as ServerWebSocket<MeshRelayWebSocketData>;
      if (socket.data.relaySocketKind === "control") {
        try {
          socket.data.relayControlConnectionId = broker.openControl(
            relaySocket(socket),
            socket.data.relayProtocolVersion,
          );
        } catch (error) {
          log.warn("Relay control connection could not be opened", {
            error: String(error),
          });
          socket.close(1013, "Relay connection unavailable");
        }
        return;
      }
      const reservationId = socket.data.relayDataReservationId;
      if (!reservationId) {
        socket.close(4401, "Relay stream reservation is missing");
        return;
      }
      broker.attachDataSocket(reservationId, relaySocket(socket));
    },
    message(rawSocket, message): void {
      const socket = rawSocket as ServerWebSocket<MeshRelayWebSocketData>;
      if (socket.data.relaySocketKind === "control") {
        const connectionId = socket.data.relayControlConnectionId;
        if (!connectionId) {
          socket.close(4401, "Relay control connection is not initialized");
          return;
        }
        broker.handleControlMessage(connectionId, message);
        return;
      }
      const reservationId = socket.data.relayDataReservationId;
      if (!reservationId) {
        socket.close(4401, "Relay stream reservation is missing");
        return;
      }
      broker.handleDataMessage(reservationId, message);
    },
    close(rawSocket, code, _reason): void {
      const socket = rawSocket as ServerWebSocket<MeshRelayWebSocketData>;
      if (socket.data.relaySocketKind === "control") {
        const connectionId = socket.data.relayControlConnectionId;
        if (connectionId) {
          broker.handleControlClose(connectionId, code);
        }
        return;
      }
      const reservationId = socket.data.relayDataReservationId;
      if (reservationId) {
        broker.closeData(
          reservationId,
          code,
          code === 1000
            ? "Relay stream closed normally"
            : "Relay stream disconnected",
        );
      }
    },
  };
}

export async function createRelayServer(
  options: CreateRelayServerOptions = {},
): Promise<RelayServer> {
  const runtimeConfig = resolveRelayRuntimeConfig(options);
  const controllerFingerprint = requireControllerFingerprint(
    options.controllerFingerprint
      ?? process.env["CLANKY_RELAY_CONTROLLER_FINGERPRINT"],
  );
  const identity = await ensureMeshRelayIdentity(runtimeConfig.dataDir);
  const store = new MeshRelayStore(runtimeConfig.dataDir);
  const broker = new MeshRelayBroker({
    identity,
    store,
    controllerFingerprint,
  });
  const descriptor = (
    request?: Request,
  ): MeshRelayWellKnownDescriptor | MeshRelayWellKnownDescriptorV5 => {
    const protocol = negotiateMeshProtocolVersion(
      [...MESH_SUPPORTED_PROTOCOL_VERSIONS],
      parseMeshProtocolVersionsHeader(
        request?.headers.get(MESH_PROTOCOL_VERSIONS_HEADER) ?? null,
      ),
    );
    return protocol === MESH_PROTOCOL_VERSION
      ? {
          role: "relay",
          protocolVersion: MESH_PROTOCOL_VERSION,
          publicKey: identity.publicKey,
          fingerprint: identity.fingerprint,
          controllerFingerprint,
          controllerNodeId: store.getController()?.nodeId ?? null,
          binaryVersion: CLANKY_VERSION,
          supportedProtocolVersions: [...MESH_SUPPORTED_PROTOCOL_VERSIONS],
          preferredProtocolVersion: MESH_PROTOCOL_VERSION,
          negotiatedProtocolVersion: protocol,
        }
      : {
          role: "relay",
          relayProtocol: MESH_RELAY_PROTOCOL_VERSION,
          enrollmentProtocol: MESH_RELAY_ENROLLMENT_PROTOCOL_VERSION,
          publicKey: identity.publicKey,
          fingerprint: identity.fingerprint,
          controllerFingerprint,
          controllerNodeId: store.getController()?.nodeId ?? null,
        };
  };
  const routes = defineRoutes({
    [MESH_RELAY_DESCRIPTOR_PATH]: {
      auth: "public",
      sameOrigin: "never",
      description: "Describe this Clanky Mesh relay and its public identity.",
      tags: ["mesh", "relay", "discovery"],
      GET(req): Response {
        const protocol = negotiateMeshProtocolVersion(
          [...MESH_SUPPORTED_PROTOCOL_VERSIONS],
          parseMeshProtocolVersionsHeader(
            req.headers.get(MESH_PROTOCOL_VERSIONS_HEADER),
          ),
        );
        return Response.json(descriptor(req), {
          headers: {
            [MESH_PROTOCOL_VERSIONS_HEADER]: serializeMeshProtocolVersions(),
            ["x-clanky-binary-version"]: CLANKY_VERSION,
            [MESH_PROTOCOL_VERSION_HEADER]: String(
              protocol ?? MESH_LEGACY_PROTOCOL_VERSION,
            ),
          },
        });
      },
    },
    [MESH_RELAY_CONTROL_PATH]: {
      auth: "public",
      sameOrigin: "never",
      description: "Open an authenticated Mesh relay control connection.",
      tags: ["mesh", "relay"],
      GET(req, ctx): Response | undefined {
        if (!isWebSocketUpgrade(req)) {
          return new Response("WebSocket upgrade required", { status: 426 });
        }
        const server = upgradeServer(ctx.server);
        if (!server) {
          return new Response("Relay server unavailable", { status: 503 });
        }
        const upgraded = server.upgrade(req, {
          data: {
            webappSocketHandler: RELAY_WEBSOCKET_HANDLER,
            relaySocketKind: "control",
            relayProtocolVersion: new URL(req.url).searchParams.get(
              "protocolVersion",
            ) === String(MESH_PROTOCOL_VERSION)
              ? MESH_PROTOCOL_VERSION
              : MESH_RELAY_PROTOCOL_VERSION,
          },
        });
        return upgraded
          ? undefined
          : new Response("WebSocket upgrade failed", { status: 503 });
      },
    },
    [MESH_RELAY_STREAM_PATH]: {
      auth: "public",
      sameOrigin: "never",
      description: "Attach one side of a ticketed Mesh relay stream.",
      tags: ["mesh", "relay"],
      GET(req, ctx): Response | undefined {
        if (!isWebSocketUpgrade(req)) {
          return new Response("WebSocket upgrade required", { status: 426 });
        }
        const url = new URL(req.url);
        const ticket = url.searchParams.get("ticket");
        const credential = url.searchParams.get("credential");
        if (!ticket || !credential || !hasValidStreamQuery(url)) {
          return new Response("Invalid relay stream ticket", { status: 401 });
        }
        const reservation = broker.reserveDataSocket(ticket, credential);
        if (!reservation) {
          return new Response("Invalid or expired relay stream ticket", {
            status: 401,
          });
        }
        const server = upgradeServer(ctx.server);
        if (!server) {
          broker.closeData(
            reservation.reservationId,
            1011,
            "Relay server unavailable",
          );
          return new Response("Relay server unavailable", { status: 503 });
        }
        const upgraded = server.upgrade(req, {
          data: {
            webappSocketHandler: RELAY_WEBSOCKET_HANDLER,
            relaySocketKind: "data",
            relayDataReservationId: reservation.reservationId,
          },
        });
        if (upgraded) {
          return undefined;
        }
        broker.closeData(
          reservation.reservationId,
          1011,
          "WebSocket upgrade failed",
        );
        return new Response("WebSocket upgrade failed", { status: 503 });
      },
    },
  });
  let app: WebAppServer;
  try {
    app = createWebAppServer({
      appName: "Clanky Relay",
      envPrefix: "CLANKY",
      appDirectoryName: ".clanky",
      runtimeConfig,
      web: false,
      version: options.version ?? CLANKY_VERSION,
      store: sqliteWebAppStore({
        dataDir: runtimeConfig.dataDir,
        fileName: "relay.db",
      }),
      auth: {
        passkeys: false,
        apiKeys: false,
        deviceAuth: false,
      },
      requestFilter: relayRequestFilter,
      routes,
      websockets: {
        [RELAY_WEBSOCKET_HANDLER]: createRelayWebSocketHandler(broker),
      },
      lifecycle: {
        beforeStop(): void {
          broker.stop();
          store.close();
        },
      },
    });
  } catch (error) {
    broker.stop();
    store.close();
    throw error;
  }
  let disposed = false;
  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    broker.stop();
    store.close();
  };
  const relayServer: RelayServer = {
    app,
    broker,
    identity,
    store,
    get descriptor() {
      return descriptor();
    },
    start: async () => {
      try {
        return await app.start();
      } catch (error) {
        dispose();
        throw error;
      }
    },
    stop: async (closeActiveConnections = true) => {
      try {
        await app.stop(closeActiveConnections);
      } finally {
        dispose();
      }
    },
  };
  return relayServer;
}

export async function startRelayServer(
  options: CreateRelayServerOptions = {},
): Promise<StartedRelayServer> {
  const relay = await createRelayServer(options);
  const server = await relay.start();
  return {
    ...relay,
    get descriptor() {
      return relay.descriptor;
    },
    server,
  };
}
