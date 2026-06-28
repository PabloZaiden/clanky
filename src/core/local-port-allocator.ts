import net from "node:net";

const LOCAL_FORWARD_HOST = "127.0.0.1";
const MAX_PORT_ALLOCATION_ATTEMPTS = 25;

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, LOCAL_FORWARD_HOST, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function ensureLocalPortAvailable(reservedPorts: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < MAX_PORT_ALLOCATION_ATTEMPTS; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, LOCAL_FORWARD_HOST, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          server.close(() => reject(new Error("Failed to allocate local port")));
          return;
        }
        server.close(() => resolve(address.port));
      });
    });
    if (!reservedPorts.has(port) && await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error("Failed to allocate a local port");
}
