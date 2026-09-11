/**
 * Proxies SSH-agent protocol connections through a systemd-owned socket.
 */

import net from "node:net";
import { isAbsolute } from "node:path";

const SYSTEMD_FIRST_LISTEN_FD = 3;

export interface SshAgentRelayOptions {
  upstreamSocketPath: string;
  listenFd?: number;
  listenPath?: string;
}

export interface SshAgentRelayHandle {
  close(): Promise<void>;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertRelayOptions(options: SshAgentRelayOptions): void {
  if (!isAbsolute(options.upstreamSocketPath)) {
    throw new Error("The SSH-agent relay upstream socket path must be absolute.");
  }
  const hasListenFd = options.listenFd !== undefined;
  const hasListenPath = options.listenPath !== undefined;
  if (hasListenFd === hasListenPath) {
    throw new Error("The SSH-agent relay requires exactly one listening socket.");
  }
  if (
    hasListenFd
    && (!Number.isSafeInteger(options.listenFd) || options.listenFd! < 0)
  ) {
    throw new Error("The SSH-agent relay listening file descriptor is invalid.");
  }
  if (hasListenPath && (!options.listenPath || !isAbsolute(options.listenPath))) {
    throw new Error("The SSH-agent relay listening socket path must be absolute.");
  }
}

export function resolveSystemdListenFd(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): number {
  if (environment["LISTEN_FDS"]?.trim() !== "1") {
    throw new Error("The SSH-agent relay must be started by a systemd socket unit.");
  }
  const listenPid = environment["LISTEN_PID"]?.trim();
  if (listenPid && listenPid !== "0" && listenPid !== String(process.pid)) {
    throw new Error("The systemd SSH-agent relay socket belongs to another process.");
  }
  return SYSTEMD_FIRST_LISTEN_FD;
}

function listenArgument(options: SshAgentRelayOptions): Parameters<net.Server["listen"]>[0] {
  if (options.listenFd !== undefined) {
    return { fd: options.listenFd } as Parameters<net.Server["listen"]>[0];
  }
  return options.listenPath!;
}

async function listenServer(
  server: net.Server,
  options: SshAgentRelayOptions,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    try {
      server.listen(listenArgument(options));
    } catch (error) {
      server.removeListener("error", onError);
      server.removeListener("listening", onListening);
      reject(error);
    }
  });
}

async function waitForConnection(socket: net.Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onConnect = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("The SSH-agent relay upstream socket closed before connecting."));
    };
    const cleanup = () => {
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function trackSocket(socket: net.Socket, sockets: Set<net.Socket>): void {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
}

async function relayClient(
  client: net.Socket,
  upstreamSocketPath: string,
  sockets: Set<net.Socket>,
): Promise<void> {
  client.pause();
  let upstream: net.Socket | undefined;
  try {
    upstream = net.createConnection({ path: upstreamSocketPath });
    trackSocket(upstream, sockets);
    await waitForConnection(upstream);
    if (client.destroyed) {
      upstream.destroy();
      return;
    }

    let closed = false;
    const closePair = () => {
      if (closed) return;
      closed = true;
      client.destroy();
      upstream?.destroy();
    };
    client.once("error", closePair);
    client.once("close", closePair);
    upstream.once("error", closePair);
    upstream.once("close", closePair);
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  } catch (error) {
    if (!client.destroyed) client.destroy();
    upstream?.destroy();
    process.stderr.write(`Clanky SSH-agent relay upstream connection failed: ${formatError(error)}\n`);
  }
}

export async function startSshAgentRelay(
  options: SshAgentRelayOptions,
): Promise<SshAgentRelayHandle> {
  assertRelayOptions(options);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    trackSocket(client, sockets);
    void relayClient(client, options.upstreamSocketPath, sockets);
  });
  await listenServer(server, options);
  server.on("error", (error) => {
    process.stderr.write(`Clanky SSH-agent relay server failed: ${formatError(error)}\n`);
  });

  let closed = false;
  return {
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

export async function runSshAgentRelay(
  options: {
    upstreamSocketPath: string;
    environment?: Readonly<Record<string, string | undefined>>;
  },
): Promise<void> {
  const relay = await startSshAgentRelay({
    upstreamSocketPath: options.upstreamSocketPath,
    listenFd: resolveSystemdListenFd(options.environment),
  });
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void relay.close().then(resolveShutdown, rejectShutdown);
  };
  let resolveShutdown: () => void = () => {};
  let rejectShutdown: (error: unknown) => void = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      resolveShutdown = resolve;
      rejectShutdown = reject;
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}
