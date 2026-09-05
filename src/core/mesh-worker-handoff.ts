import { createServer, createConnection, type Socket } from "node:net";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SOCKET_ENV = "CLANKY_WORKER_HANDOFF_SOCKET";
const TOKEN_ENV = "CLANKY_WORKER_HANDOFF_TOKEN";
const HANDOFF_TIMEOUT_MS = 30_000;

interface WorkerHandoffChild {
  started(dataDir: string): Promise<void>;
}

function waitForLine(socket: Socket, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for worker handoff message: ${expected}`));
    }, HANDOFF_TIMEOUT_MS);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      if (lines.includes(expected)) {
        cleanup();
        resolve();
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error(`Worker handoff socket closed before ${expected}`));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

export async function connectWorkerHandoffFromEnvironment(): Promise<WorkerHandoffChild | null> {
  const socketPath = process.env[SOCKET_ENV];
  const token = process.env[TOKEN_ENV];
  const parentPid = Number(process.env["CLANKY_WORKER_HANDOFF_PARENT_PID"]);
  const fromVersion = process.env["CLANKY_WORKER_HANDOFF_FROM_VERSION"] ?? "unknown";
  const targetVersion = process.env["CLANKY_WORKER_HANDOFF_TARGET_VERSION"] ?? "unknown";
  const operationId = process.env["CLANKY_WORKER_HANDOFF_OPERATION_ID"] ?? null;
  if (!socketPath || !token) return null;
  delete process.env[SOCKET_ENV];
  delete process.env[TOKEN_ENV];
  delete process.env["CLANKY_WORKER_HANDOFF_PARENT_PID"];
  delete process.env["CLANKY_WORKER_HANDOFF_FROM_VERSION"];
  delete process.env["CLANKY_WORKER_HANDOFF_TARGET_VERSION"];
  delete process.env["CLANKY_WORKER_HANDOFF_OPERATION_ID"];

  const socket = createConnection(socketPath);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(`ready:${token}\n`);
  await waitForLine(socket, `proceed:${token}`);
  return {
    async started(dataDir: string): Promise<void> {
      const pidPath = join(dataDir, "server.pid");
      try {
        const metadata = await Bun.file(pidPath).json() as Record<string, unknown>;
        if (metadata["pid"] === parentPid) {
          const temporaryPath = `${pidPath}.${String(process.pid)}.tmp`;
          await Bun.write(temporaryPath, `${JSON.stringify({
            ...metadata,
            pid: process.pid,
            startedAt: new Date().toISOString(),
          }, null, 2)}\n`);
          await rename(temporaryPath, pidPath);
        }
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
      const updateStatusPath = join(dataDir, "mesh-worker-update.json");
      const temporaryStatusPath = `${updateStatusPath}.${String(process.pid)}.tmp`;
      await Bun.write(temporaryStatusPath, `${JSON.stringify({
        operationId,
        state: "succeeded",
        fromVersion,
        targetVersion,
        startedAt: null,
        completedAt: new Date().toISOString(),
        error: null,
      }, null, 2)}\n`);
      await rename(temporaryStatusPath, updateStatusPath);
      socket.end(`started:${token}\n`);
    },
  };
}

export async function createWorkerHandoffParent(): Promise<{
  socketPath: string;
  token: string;
  waitForReady(): Promise<void>;
  proceed(): void;
  waitForStarted(): Promise<void>;
  close(): Promise<void>;
}> {
  const socketPath = join(tmpdir(), `clanky-handoff-${crypto.randomUUID()}.sock`);
  const token = crypto.randomUUID();
  let socket: Socket | undefined;
  let buffer = "";
  const messages = new Set<string>();
  const waiters = new Map<string, () => void>();
  const server = createServer((connection) => {
    socket = connection;
    connection.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        messages.add(line);
        waiters.get(line)?.();
        waiters.delete(line);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  const waitForSocket = async (): Promise<Socket> => {
    if (socket) return socket;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for replacement worker")), HANDOFF_TIMEOUT_MS);
      server.once("connection", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return socket!;
  };
  const waitForMessage = async (message: string): Promise<void> => {
    await waitForSocket();
    if (messages.has(message)) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(message);
        reject(new Error(`Timed out waiting for worker handoff message: ${message}`));
      }, HANDOFF_TIMEOUT_MS);
      waiters.set(message, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };
  return {
    socketPath,
    token,
    async waitForReady(): Promise<void> {
      await waitForMessage(`ready:${token}`);
    },
    proceed(): void {
      if (!socket) throw new Error("Replacement worker is not connected");
      socket.write(`proceed:${token}\n`);
    },
    async waitForStarted(): Promise<void> {
      await waitForMessage(`started:${token}`);
    },
    async close(): Promise<void> {
      socket?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(socketPath, { force: true });
    },
  };
}

export function workerHandoffEnvironment(socketPath: string, token: string): Record<string, string> {
  return {
    [SOCKET_ENV]: socketPath,
    [TOKEN_ENV]: token,
    CLANKY_WORKER_HANDOFF_PARENT_PID: String(process.pid),
  };
}
