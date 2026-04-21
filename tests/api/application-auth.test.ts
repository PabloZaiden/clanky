import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  wrapRouteHandlerWithApplicationAuth,
  wrapRoutesWithApplicationAuth,
} from "../../src/api/application-auth";
import { authRoutes } from "../../src/api/auth";
import { PASSKEY_AUTH_REQUIRED_HEADER } from "../../src/lib/passkey-auth-http";
import {
  getOrCreatePasskeyAuthSecret,
  getPasskeyAuthVersion,
  savePasskey,
} from "../../src/persistence/passkey-auth";
import { getDatabase } from "../../src/persistence/database";
import { listLatestRefreshSessions } from "../../src/persistence/auth";
import { setupTestContext, teardownTestContext, type TestContext } from "../setup";

function createSignedPasskeySessionCookie(
  payload: {
    nonce: string;
    version: number;
    expiresAt: number;
  },
  secret: string,
): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedPayload, "utf8").digest("base64url");
  return `ralpher_passkey_session=${encodedPayload}.${signature}`;
}

async function issueBearerToken(): Promise<string> {
  const startResponse = await authRoutes["/api/auth/device"].POST(
    new Request("http://example.test/api/auth/device", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        clientId: "application-auth-tests",
      }),
    }),
  );
  const startBody = await startResponse.json() as {
    device_code: string;
    user_code: string;
  };

  const secret = await getOrCreatePasskeyAuthSecret();
  const version = await getPasskeyAuthVersion();
  const cookie = createSignedPasskeySessionCookie({
    nonce: "application-auth-session",
    version,
    expiresAt: Date.now() + 60_000,
  }, secret);
  await authRoutes["/api/auth/device/approve"].POST(
    new Request("http://example.test/api/auth/device/approve", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        userCode: startBody.user_code,
      }),
    }),
  );

  const tokenResponse = await authRoutes["/api/auth/token"].POST(
    new Request("http://example.test/api/auth/token", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: startBody.device_code,
        client_id: "application-auth-tests",
      }),
    }),
  );
  const tokenBody = await tokenResponse.json() as { access_token: string };
  return tokenBody.access_token;
}

describe("application auth", () => {
  let context: TestContext;

  beforeEach(async () => {
    context = await setupTestContext();
    await savePasskey({
      id: "pk-1",
      name: "Primary passkey",
      credentialId: "credential-1",
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
    });
  });

  afterEach(async () => {
    await teardownTestContext(context);
  });

  test("keeps passkey protection when no bearer token is present", async () => {
    const wrappedRoutes = wrapRoutesWithApplicationAuth({
      "/api/protected": {
        GET: async () => Response.json({ ok: true }),
      },
    });
    const protectedRoute = wrappedRoutes["/api/protected"] as { GET: (req: Request) => Promise<Response> };

    const response = await protectedRoute.GET(new Request("http://example.test/api/protected"));

    expect(response.status).toBe(401);
    expect(response.headers.get(PASSKEY_AUTH_REQUIRED_HEADER)).toBe("true");
  });

  test("allows websocket-style handlers when a valid bearer token is present", async () => {
    const accessToken = await issueBearerToken();
    let upgradeCalled = false;
    const wrappedHandler = wrapRouteHandlerWithApplicationAuth(
      (_req: Request, server: { upgrade: () => boolean }) => {
        upgradeCalled = true;
        server.upgrade();
        return undefined;
      },
    );

    const response = await wrappedHandler(
      new Request("http://example.test/api/ws", {
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
      }),
      { upgrade: () => true },
    );

    expect(response).toBeUndefined();
    expect(upgradeCalled).toBe(true);
  });

  test("ignores non-bearer authorization headers when a passkey session is valid", async () => {
    const wrappedRoutes = wrapRoutesWithApplicationAuth({
      "/api/protected": {
        GET: async () => Response.json({ ok: true }),
      },
    });
    const protectedRoute = wrappedRoutes["/api/protected"] as { GET: (req: Request) => Promise<Response> };

    const secret = await getOrCreatePasskeyAuthSecret();
    const version = await getPasskeyAuthVersion();
    const cookie = createSignedPasskeySessionCookie({
      nonce: "application-auth-basic-header-session",
      version,
      expiresAt: Date.now() + 60_000,
    }, secret);

    const response = await protectedRoute.GET(new Request("http://example.test/api/protected", {
      headers: {
        authorization: "Basic cHJveHktZm9yd2FyZGVkOmhlYWRlcg==",
        cookie,
      },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("throttles refresh-session touches during repeated bearer validation", async () => {
    const accessToken = await issueBearerToken();
    const [session] = await listLatestRefreshSessions();
    expect(session).toBeDefined();

    const db = getDatabase();
    const freshTimestamp = new Date().toISOString();
    db.run(
      "UPDATE auth_refresh_sessions SET last_used_at = ?, updated_at = ? WHERE id = ?",
      [freshTimestamp, freshTimestamp, session!.id],
    );

    const wrappedRoutes = wrapRoutesWithApplicationAuth({
      "/api/protected": {
        GET: async () => Response.json({ ok: true }),
      },
    });
    const protectedRoute = wrappedRoutes["/api/protected"] as { GET: (req: Request) => Promise<Response> };

    const firstResponse = await protectedRoute.GET(new Request("http://example.test/api/protected", {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    }));
    expect(firstResponse.status).toBe(200);

    const untouchedRow = db.query(
      "SELECT last_used_at, updated_at FROM auth_refresh_sessions WHERE id = ?",
    ).get(session!.id) as { last_used_at: string; updated_at: string };
    expect(untouchedRow.last_used_at).toBe(freshTimestamp);
    expect(untouchedRow.updated_at).toBe(freshTimestamp);

    const staleTimestamp = new Date(Date.now() - 120_000).toISOString();
    db.run(
      "UPDATE auth_refresh_sessions SET last_used_at = ?, updated_at = ? WHERE id = ?",
      [staleTimestamp, staleTimestamp, session!.id],
    );

    const secondResponse = await protectedRoute.GET(new Request("http://example.test/api/protected", {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    }));
    expect(secondResponse.status).toBe(200);

    const touchedRow = db.query(
      "SELECT last_used_at, updated_at FROM auth_refresh_sessions WHERE id = ?",
    ).get(session!.id) as { last_used_at: string; updated_at: string };
    expect(touchedRow.last_used_at).not.toBe(staleTimestamp);
    expect(touchedRow.updated_at).not.toBe(staleTimestamp);
  });
});
