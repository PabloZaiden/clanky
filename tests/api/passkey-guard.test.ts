import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  wrapRouteHandlerWithPasskeyAuth,
  wrapRoutesWithPasskeyAuth,
} from "../../src/api/passkey-guard";
import { savePasskey } from "../../src/persistence/passkey-auth";
import { setupTestContext, teardownTestContext, type TestContext } from "../setup";

describe("passkey guard", () => {
  let context: TestContext;
  const originalDisablePasskey = process.env["RALPHER_DISABLE_PASSKEY"];

  beforeEach(async () => {
    delete process.env["RALPHER_DISABLE_PASSKEY"];
    context = await setupTestContext();
  });

  afterEach(async () => {
    if (originalDisablePasskey === undefined) {
      delete process.env["RALPHER_DISABLE_PASSKEY"];
    } else {
      process.env["RALPHER_DISABLE_PASSKEY"] = originalDisablePasskey;
    }
    await teardownTestContext(context);
  });

  test("allows requests when no passkey is configured", async () => {
    const wrappedRoutes = wrapRoutesWithPasskeyAuth({
      "/api/protected": {
        GET: async () => Response.json({ ok: true }),
      },
    });
    const protectedRoute = wrappedRoutes["/api/protected"] as { GET: (req: Request) => Promise<Response> };

    const response = await protectedRoute.GET(new Request("http://example.test/api/protected"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("skips configured public routes even when a passkey exists", async () => {
    await savePasskey({
      id: "pk-1",
      name: "Primary passkey",
      credentialId: "credential-1",
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
    });

    const wrappedRoutes = wrapRoutesWithPasskeyAuth({
      "/api/passkey-auth/status": {
        GET: async () => Response.json({ ok: true }),
      },
      "/api/protected": {
        GET: async () => Response.json({ ok: true }),
      },
    }, new Set(["/api/passkey-auth/status"]));
    const publicRoute = wrappedRoutes["/api/passkey-auth/status"] as { GET: (req: Request) => Promise<Response> };
    const protectedRoute = wrappedRoutes["/api/protected"] as { GET: (req: Request) => Promise<Response> };

    const publicResponse = await publicRoute.GET(
      new Request("http://example.test/api/passkey-auth/status"),
    );
    const protectedResponse = await protectedRoute.GET(
      new Request("http://example.test/api/protected"),
    );

    expect(publicResponse.status).toBe(200);
    expect(protectedResponse.status).toBe(401);
    expect(await protectedResponse.json()).toEqual({
      error: "authentication_required",
      message: "Passkey authentication is required",
    });
  });

  test("bypasses passkey guard when RALPHER_DISABLE_PASSKEY is enabled", async () => {
    await savePasskey({
      id: "pk-1",
      name: "Primary passkey",
      credentialId: "credential-1",
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
    });
    process.env["RALPHER_DISABLE_PASSKEY"] = "true";

    const wrappedRoutes = wrapRoutesWithPasskeyAuth({
      "/api/protected": {
        GET: async () => Response.json({ ok: true }),
      },
    });
    const protectedRoute = wrappedRoutes["/api/protected"] as { GET: (req: Request) => Promise<Response> };

    const response = await protectedRoute.GET(new Request("http://example.test/api/protected"));

    expect(response.status).toBe(200);
  });

  test("blocks websocket-style handlers when a passkey is configured and no session exists", async () => {
    await savePasskey({
      id: "pk-1",
      name: "Primary passkey",
      credentialId: "credential-1",
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
    });

    let upgradeCalled = false;
    const wrappedHandler = wrapRouteHandlerWithPasskeyAuth(
      (_req: Request, server: { upgrade: () => boolean }) => {
        upgradeCalled = true;
        server.upgrade();
        return undefined;
      },
    );

    const response = await wrappedHandler(
      new Request("http://example.test/api/ws"),
      { upgrade: () => true },
    );

    expect(response?.status).toBe(401);
    expect(upgradeCalled).toBe(false);
  });
});
