import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import type { CurrentUser } from "@pablozaiden/webapp/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getExecutionHostSourceId, type ExecutionHostDescriptor } from "@/shared";
import { previewSessionManager } from "../../src/core/preview-session-manager";
import { runWithCurrentUser } from "../../src/core/user-context";
import { closeDatabase, getDatabase, initializeDatabase } from "../../src/persistence/database";
import { deleteSshServer, saveSshServerConfig } from "../../src/persistence/ssh-servers";
import { serveNativeApiRoutes } from "../native-api-server";
import { seedTestOwnerUser, testOwnerUser } from "../setup";

describe("Preview API", () => {
  let server: Server<unknown>;
  let baseUrl: string;
  let testDataDir: string;

  beforeAll(async () => {
    testDataDir = await mkdtemp(join(tmpdir(), "clanky-previews-api-"));
    process.env["CLANKY_DATA_DIR"] = testDataDir;
    await initializeDatabase();
    seedTestOwnerUser();
    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  beforeEach(() => {
    getDatabase().run("DELETE FROM preview_sessions");
  });

  afterAll(async () => {
    server.stop();
    closeDatabase();
    await rm(testDataDir, { recursive: true, force: true });
    delete process.env["CLANKY_DATA_DIR"];
  });

  async function getLocalHost(): Promise<ExecutionHostDescriptor> {
    const response = await fetch(`${baseUrl}/api/execution-hosts`);
    expect(response.status).toBe(200);
    const hosts = await response.json() as ExecutionHostDescriptor[];
    const localHost = hosts.find((host) => host.ref.kind === "local");
    if (!localHost) {
      throw new Error("Local execution host is unavailable");
    }
    return localHost;
  }

  test("lists direct previews by execution host and keeps workspace scope separate", async () => {
    const localHost = await getLocalHost();
    const { preview } = await runWithCurrentUser(testOwnerUser, async () =>
      await previewSessionManager.registerCliPreview({
        target: {
          kind: "server",
          reference: getExecutionHostSourceId(localHost.ref),
        },
        remoteHost: "localhost",
        remotePort: 3000,
        localHost: "127.0.0.1",
        localPort: 43123,
        localUrl: "http://127.0.0.1:43123/",
        initialPath: "/",
      }));

    try {
      const response = await fetch(
        `${baseUrl}/api/execution-hosts/local/${encodeURIComponent(
          localHost.ref.kind === "local" ? localHost.ref.nodeId : "",
        )}/previews`,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([preview]);
      expect(preview.config.workspaceId).toBeUndefined();
    } finally {
      await runWithCurrentUser(testOwnerUser, async () => {
        await previewSessionManager.closePreview(preview.config.id, "test cleanup");
      });
    }
  });

  test("does not expose an owner's direct preview to another user", async () => {
    const localHost = await getLocalHost();
    const { preview } = await runWithCurrentUser(testOwnerUser, async () =>
      await previewSessionManager.registerCliPreview({
        target: {
          kind: "server",
          reference: getExecutionHostSourceId(localHost.ref),
        },
        remoteHost: "localhost",
        remotePort: 3000,
        localHost: "127.0.0.1",
        localPort: 43123,
        localUrl: "http://127.0.0.1:43123/",
        initialPath: "/",
      }));
    const otherUser: CurrentUser = {
      id: "other-user",
      username: "other-user",
      role: "user",
      isOwner: false,
      isAdmin: false,
    };
    const otherServer = serveNativeApiRoutes({ user: otherUser });
    const otherBaseUrl = otherServer.url.toString().replace(/\/$/, "");
    try {
      const response = await fetch(
        `${otherBaseUrl}/api/execution-hosts/local/${encodeURIComponent(
          localHost.ref.kind === "local" ? localHost.ref.nodeId : "",
        )}/previews`,
      );
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        error: "execution_host_unavailable",
      });
    } finally {
      otherServer.stop();
      await runWithCurrentUser(testOwnerUser, async () => {
        await previewSessionManager.closePreview(preview.config.id, "test cleanup");
      });
    }
  });

  test("rejects direct SSH preview listing", async () => {
    const serverId = "ssh-preview-api-server";
    await runWithCurrentUser(testOwnerUser, async () => {
      await saveSshServerConfig({
        id: serverId,
        name: "SSH preview API server",
        address: "127.0.0.1",
        port: 22,
        username: "preview",
        repositoriesBasePath: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isPrivate: false,
      });
    });
    try {
      const response = await fetch(
        `${baseUrl}/api/execution-hosts/ssh/${encodeURIComponent(serverId)}/previews`,
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: "preview_server_unsupported",
      });
    } finally {
      await runWithCurrentUser(testOwnerUser, async () => {
        await deleteSshServer(serverId);
      });
    }
  });
});
