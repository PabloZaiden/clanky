import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VncSessionManager } from "../../src/core/vnc-session-manager";
import { runWithCurrentUser } from "../../src/core/user-context";
import { closeDatabase, initializeDatabase } from "../../src/persistence/database";
import {
  ensureExecutionHost,
  updateExecutionHostRuntimeSnapshot,
} from "../../src/persistence/execution-hosts";
import { saveVncSession } from "../../src/persistence/vnc-sessions";
import { seedTestOwnerUser, testOwnerUser } from "../setup";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "clanky-vnc-capabilities-"));
  closeDatabase();
  process.env["CLANKY_DATA_DIR"] = dataDir;
  await initializeDatabase();
  seedTestOwnerUser();
});

afterEach(async () => {
  closeDatabase();
  delete process.env["CLANKY_DATA_DIR"];
  await rm(dataDir, { recursive: true, force: true });
});

describe("VNC session capabilities", () => {
  // Opening a persisted session is a lifecycle boundary that cannot be covered
  // through the HTTP API because the socket is established by a raw WebSocket.
  test("rejects an active session after its host loses VNC support", async () => {
    await runWithCurrentUser(testOwnerUser, async () => {
      const manager = new VncSessionManager();
      await manager.initialize();
      const ref = { kind: "mesh" as const, nodeId: "vnc-worker" };
      const host = ensureExecutionHost(
        testOwnerUser.id,
        ref,
        "mesh:vnc-worker",
        {
          runtime: {
            platform: { os: "linux", architecture: "x64" },
            capabilities: { tcpTunnel: 1, vnc: 1 },
          },
        },
      );
      const binding = {
        host: ref,
        targetKey: host.targetKey,
        revision: host.revision,
      };
      const now = new Date().toISOString();
      await saveVncSession({
        config: {
          id: "vnc-session",
          executionHostBinding: binding,
          remoteHost: "127.0.0.1",
          remotePort: 5900,
          localPort: 5901,
          createdAt: now,
          updatedAt: now,
        },
        state: {
          status: "active",
          connectedAt: now,
        },
      });
      updateExecutionHostRuntimeSnapshot(testOwnerUser.id, ref, {
        platform: { os: "linux", architecture: "x64" },
        capabilities: { tcpTunnel: 1 },
      });

      await expect(manager.openTcpSocket("vnc-session")).rejects.toMatchObject({
        code: "execution_host_capability_unavailable",
        details: { capability: "vnc" },
      });
    });
  });
});
