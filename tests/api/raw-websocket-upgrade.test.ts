import { describe, expect, test } from "bun:test";
import type { RouteContext } from "@pablozaiden/webapp/server";
import { routes } from "../../src/server";
import { authorizedRawWebSocketUpgrade } from "../../src/api/raw-websocket-upgrade";
import type { ClankyRealtimeEvent } from "../../src/realtime";
import { testOwnerUser } from "../setup";

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
  test("preserves successful and failed upgrade results without mesh authority checks", async () => {
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

  test("keeps route validation and transport-specific payloads at the route boundary", async () => {
    const sshResponse = await getRouteHandler("/api/ssh-terminal")(
      new Request("http://localhost/api/ssh-terminal"),
      createRouteContext(),
    );
    expect(sshResponse?.status).toBe(400);
    expect(await sshResponse?.text()).toBe("sshServerSessionId is required");

    const terminalResponse = await getRouteHandler("/api/terminal")(
      new Request("http://localhost/api/terminal"),
      createRouteContext(),
    );
    expect(terminalResponse?.status).toBe(400);
    expect(await terminalResponse?.text()).toBe("terminalSessionId is required");

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
