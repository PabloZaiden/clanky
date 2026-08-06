import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { RouteContext } from "@pablozaiden/webapp/server";
import { routes } from "../../src/server";
import {
  authorizedRawWebSocketUpgrade,
  meshAuthorityErrorResponse,
} from "../../src/api/raw-websocket-upgrade";
import { DomainError } from "../../src/core/domain-error";
import { ensureLocalMeshNodeIdentity } from "../../src/persistence/mesh-node-identity";
import { createMeshLink } from "../../src/persistence/mesh";
import { closeDatabase, getDatabase, initializeDatabase } from "../../src/persistence/database";
import type { ClankyRealtimeEvent } from "../../src/realtime";
import { seedTestOwnerUser, testOwnerUser } from "../setup";

let dataDir: string;
const originalDataDir = process.env["CLANKY_DATA_DIR"];

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function getRouteHandler(path: string): NonNullable<typeof routes[string]["GET"]> {
  const handler = routes[path]?.GET;
  if (!handler) {
    throw new Error(`Route ${path} does not define a GET handler`);
  }
  return handler;
}

function createRouteContext(
  upgrade?: (request: Request, options?: { data?: unknown }) => boolean,
): RouteContext<Record<string, string>, ClankyRealtimeEvent> {
  return {
    requireUser: () => testOwnerUser,
    server: upgrade ? { upgrade } : undefined,
  } as unknown as RouteContext<Record<string, string>, ClankyRealtimeEvent>;
}

describe("raw WebSocket upgrade flow", () => {
  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-raw-upgrade-data-"));
    closeDatabase();
    process.env["CLANKY_DATA_DIR"] = dataDir;
    await initializeDatabase();
    seedTestOwnerUser();
  });

  afterEach(() => {
    getDatabase().run("DELETE FROM mesh_links");
  });

  afterAll(async () => {
    closeDatabase();
    if (originalDataDir === undefined) {
      delete process.env["CLANKY_DATA_DIR"];
    } else {
      process.env["CLANKY_DATA_DIR"] = originalDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  test("does not invoke the upgrade operation when mesh authority is inactive", async () => {
    const identity = await ensureLocalMeshNodeIdentity();
    const link = await createMeshLink({
      localUserId: testOwnerUser.id,
      localNodeId: identity.nodeId,
      localNodeEndpoint: "http://127.0.0.1:3000",
      localNodeTransport: "http",
    });
    getDatabase().run("UPDATE mesh_links SET status = 'conflict' WHERE link_id = ?", [link.linkId]);

    let upgradeCalled = false;
    const response = await authorizedRawWebSocketUpgrade(testOwnerUser.id, () => {
      upgradeCalled = true;
      return undefined;
    });

    expect(upgradeCalled).toBe(false);
    expect(response?.status).toBe(409);
    await expect(readJson(response!)).resolves.toMatchObject({
      error: "mesh_link_conflict",
      message: "The linked mesh has an unresolved authority conflict",
    });
  });

  test("preserves successful and failed upgrade results after authority passes", async () => {
    let successCalled = false;
    const success = await authorizedRawWebSocketUpgrade("unlinked-user", () => {
      successCalled = true;
      return undefined;
    });
    expect(successCalled).toBe(true);
    expect(success).toBeUndefined();

    const failure = await authorizedRawWebSocketUpgrade(
      "unlinked-user",
      () => new Response("WebSocket upgrade failed", { status: 400 }),
    );
    expect(failure?.status).toBe(400);
    if (!failure) {
      throw new Error("Expected the failed upgrade response");
    }
    await expect(failure.text()).resolves.toBe("WebSocket upgrade failed");
  });

  test("maps known and unknown authority failures to safe responses", async () => {
    const expectedMappings = [
      {
        code: "linked_node_not_active",
        status: 409,
        message: "This Clanky instance is not the active mesh node",
      },
      {
        code: "mesh_link_conflict",
        status: 409,
        message: "The linked mesh has an unresolved authority conflict",
      },
      {
        code: "mesh_link_revoked",
        status: 403,
        message: "The linked mesh membership has been revoked",
      },
    ] as const;

    for (const expected of expectedMappings) {
      const response = meshAuthorityErrorResponse(new DomainError(expected.code, "internal detail"));
      expect(response.status).toBe(expected.status);
      await expect(readJson(response)).resolves.toMatchObject({
        error: expected.code,
        message: expected.message,
      });
    }

    const fallback = meshAuthorityErrorResponse(new Error("internal detail"));
    expect(fallback.status).toBe(500);
    await expect(readJson(fallback)).resolves.toEqual({
      error: "mesh_authority_check_failed",
      message: "Mesh authority could not be verified",
    });
  });

  test("keeps route validation and transport-specific payloads at the route boundary", async () => {
    const sshResponse = await getRouteHandler("/api/ssh-terminal")(
      new Request("http://localhost/api/ssh-terminal"),
      createRouteContext(),
    );
    expect(sshResponse?.status).toBe(400);
    expect(await sshResponse?.text()).toBe("sshSessionId or sshServerSessionId is required");

    const vncResponse = await getRouteHandler("/api/vnc")(
      new Request("http://localhost/api/vnc"),
      createRouteContext(),
    );
    expect(vncResponse?.status).toBe(400);
    expect(await vncResponse?.text()).toBe("vncSessionId is required");

    let upgradeData: unknown;
    const upgradeResponse = await getRouteHandler("/api/vnc")(
      new Request("http://localhost/api/vnc?vncSessionId=vnc-1"),
      createRouteContext((_request, options) => {
        upgradeData = options?.data;
        return true;
      }),
    );
    expect(upgradeResponse).toBeUndefined();
    expect(upgradeData).toMatchObject({
      webappSocketHandler: "clanky",
      vncSessionId: "vnc-1",
      vncMode: true,
      user: testOwnerUser,
    });
  });
});
