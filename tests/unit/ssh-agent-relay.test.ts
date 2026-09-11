import { expect, test } from "bun:test";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveSystemdListenFd,
  startSshAgentRelay,
} from "../../src/cli/ssh-agent-relay";

async function listenUnix(
  path: string,
  handler: (socket: Socket) => void,
): Promise<Server> {
  const server = createServer(handler);
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
    server.listen(path);
  });
  return server;
}

async function closeServer(server: Server, socketPath: string): Promise<void> {
  if (server.listening) {
    await new Promise<void>((resolve, reject) => {
      server.close((error?: Error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
  await rm(socketPath, { force: true });
}

async function connectUnix(path: string): Promise<Socket> {
  const connection = createConnection({ path });
  await new Promise<void>((resolve, reject) => {
    connection.once("connect", resolve);
    connection.once("error", reject);
  });
  return connection;
}

async function exchange(socket: Socket, payload: Uint8Array): Promise<Buffer> {
  return await new Promise<Buffer>((resolve, reject) => {
    socket.once("data", (data) => resolve(Buffer.from(data)));
    socket.once("error", reject);
    socket.write(payload);
  });
}

test("validates systemd socket activation metadata", () => {
  expect(resolveSystemdListenFd({
    LISTEN_FDS: "1",
    LISTEN_PID: String(process.pid),
  })).toBe(3);
  expect(() => resolveSystemdListenFd({ LISTEN_FDS: "0" })).toThrow(
    "must be started by a systemd socket unit",
  );
});

test("keeps the relay listener stable while reconnecting to a replaced upstream socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "clanky-ssh-agent-relay-"));
  const relayPath = join(directory, "relay.sock");
  const upstreamPath = join(directory, "upstream.sock");
  let upstream = await listenUnix(upstreamPath, (socket) => {
    socket.on("data", (data) => socket.write(data));
  });
  const relay = await startSshAgentRelay({
    listenPath: relayPath,
    upstreamSocketPath: upstreamPath,
  });
  try {
    const relayInode = (await stat(relayPath)).ino;
    const firstClient = await connectUnix(relayPath);
    await expect(exchange(firstClient, Buffer.from("first"))).resolves.toEqual(Buffer.from("first"));
    firstClient.destroy();

    await closeServer(upstream, upstreamPath);
    upstream = await listenUnix(upstreamPath, (socket) => {
      socket.on("data", (data) => socket.write(data));
    });

    const secondClient = await connectUnix(relayPath);
    await expect(exchange(secondClient, Buffer.from("second"))).resolves.toEqual(Buffer.from("second"));
    secondClient.destroy();
    expect((await stat(relayPath)).ino).toBe(relayInode);
  } finally {
    await relay.close();
    await closeServer(upstream, upstreamPath);
    await rm(directory, { recursive: true, force: true });
  }
});
