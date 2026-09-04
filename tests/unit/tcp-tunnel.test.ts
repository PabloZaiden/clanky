import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  closeDatabase,
  initializeDatabase,
} from "../../src/persistence/database";
import { executionHostService } from "../../src/core/execution-host-service";
import { openTcpTunnel } from "../../src/core/tcp-tunnel";
import { runWithCurrentUser } from "../../src/core/user-context";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";

const owner: CurrentUser = {
  id: "tcp-tunnel-owner",
  username: "owner",
  role: "owner",
  isOwner: true,
  isAdmin: true,
};
let dataDir: string | null = null;

afterEach(async () => {
  closeDatabase();
  if (dataDir) {
    await rm(dataDir, { recursive: true, force: true });
    dataDir = null;
  }
  delete process.env["CLANKY_DATA_DIR"];
});

describe("TCP tunnel", () => {
  test("relays bytes through a local execution host", async () => {
    dataDir = join(process.cwd(), ".clanky-test-tmp", `tcp-tunnel-${crypto.randomUUID()}`);
    await mkdir(dataDir, { recursive: true });
    process.env["CLANKY_DATA_DIR"] = dataDir;
    await initializeDatabase();

    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket, data) {
          socket.write(data);
        },
      },
    });

    try {
      await runWithCurrentUser(owner, async () => {
        const host = (await executionHostService.listHosts())
          .find((candidate) => candidate.ref.kind === "local");
        expect(host).toBeDefined();
        const tunnel = await openTcpTunnel({
          binding: {
            host: host!.ref,
            targetKey: host!.targetKey,
            revision: host!.revision,
          },
          remoteHost: "127.0.0.1",
          remotePort: server.port,
        });
        const echoed = new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("Timed out waiting for TCP echo")), 2_000);
          tunnel.once("error", reject);
          tunnel.on("data", (data) => {
            clearTimeout(timer);
            resolve(Buffer.from(data).toString("utf8"));
          });
        });
        tunnel.write("mesh-ready");
        expect(await echoed).toBe("mesh-ready");
        tunnel.destroy();
      });
    } finally {
      server.stop(true);
    }
  });
});
