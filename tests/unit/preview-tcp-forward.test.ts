import net from "node:net";
import { describe, expect, test } from "bun:test";
import type { ExecutionHostBinding } from "@/shared";
import { openForwardedTcpTunnel } from "../../src/core/tcp-tunnel";
import { openPreviewTcpForward } from "../../src/core/preview-tcp-forward";

const meshBinding: ExecutionHostBinding = {
  host: {
    kind: "mesh",
    nodeId: "worker-1",
  },
  targetKey: "mesh:worker-1",
  revision: 1,
};

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({
      host: "127.0.0.1",
      port: 0,
    }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a port");
  }
  return address.port;
}

async function close(server: net.Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function readResponse(socket: net.Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for preview TCP forward data"));
    }, 2_000);
    socket.on("data", (data) => {
      chunks.push(Buffer.from(data));
      clearTimeout(timer);
      socket.destroy();
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

describe("preview TCP forward", () => {
  test("forwards Mesh preview connections to the worker loopback service", async () => {
    const workerServer = net.createServer((socket) => {
      socket.on("data", (data) => {
        const bytes = typeof data === "string" ? Buffer.from(data) : data;
        socket.write(Buffer.concat([Buffer.from("worker:"), bytes]));
      });
    });
    const workerPort = await listen(workerServer);
    const forward = await openPreviewTcpForward(meshBinding, workerPort, {
      openTunnel: async ({ remotePort }) => openForwardedTcpTunnel(remotePort),
    });

    try {
      const browserSocket = net.createConnection({
        host: "127.0.0.1",
        port: forward.localPort,
      });
      browserSocket.once("connect", () => browserSocket.write("preview"));
      expect(await readResponse(browserSocket)).toBe("worker:preview");
    } finally {
      await forward.close();
      await close(workerServer);
    }
  });
});
