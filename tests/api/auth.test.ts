import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { authRoutes } from "../../src/api/auth";
import {
  getOrCreatePasskeyAuthSecret,
  getPasskeyAuthVersion,
  savePasskey,
} from "../../src/persistence/passkey-auth";
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

describe("auth routes", () => {
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

  test("completes the device flow and rotates refresh tokens", async () => {
    const startResponse = await authRoutes["/api/auth/device"].POST(
      new Request("http://example.test/api/auth/device", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          clientId: "ralpher-cli-tests",
          scope: "loops:read loops:write",
        }),
      }),
    );

    expect(startResponse.status).toBe(200);
    const startBody = await startResponse.json() as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete: string;
      expires_in: number;
      interval: number;
    };
    expect(startBody.verification_uri).toBe("http://example.test/device");
    expect(startBody.verification_uri_complete).toContain(startBody.user_code);
    expect(startBody.interval).toBeGreaterThan(0);

    const secret = await getOrCreatePasskeyAuthSecret();
    const version = await getPasskeyAuthVersion();
    const cookie = createSignedPasskeySessionCookie({
      nonce: "auth-test-session",
      version,
      expiresAt: Date.now() + 60_000,
    }, secret);

    const approveResponse = await authRoutes["/api/auth/device/approve"].POST(
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

    expect(approveResponse.status).toBe(200);
    expect(await approveResponse.json()).toEqual(expect.objectContaining({
      userCode: startBody.user_code,
      status: "approved",
    }));

    const tokenResponse = await authRoutes["/api/auth/token"].POST(
      new Request("http://example.test/api/auth/token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: startBody.device_code,
          client_id: "ralpher-cli-tests",
        }),
      }),
    );

    expect(tokenResponse.status).toBe(200);
    const tokenBody = await tokenResponse.json() as {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    expect(typeof tokenBody.access_token).toBe("string");
    expect(typeof tokenBody.refresh_token).toBe("string");
    expect(tokenBody.expires_in).toBeGreaterThan(0);

    const refreshResponse = await authRoutes["/api/auth/token"].POST(
      new Request("http://example.test/api/auth/token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: tokenBody.refresh_token,
          client_id: "ralpher-cli-tests",
        }),
      }),
    );

    expect(refreshResponse.status).toBe(200);
    const refreshBody = await refreshResponse.json() as {
      refresh_token: string;
    };
    expect(refreshBody.refresh_token).not.toBe(tokenBody.refresh_token);

    const reuseResponse = await authRoutes["/api/auth/token"].POST(
      new Request("http://example.test/api/auth/token", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: tokenBody.refresh_token,
          client_id: "ralpher-cli-tests",
        }),
      }),
    );

    expect(reuseResponse.status).toBe(400);
    expect(await reuseResponse.json()).toEqual({
      error: "invalid_grant",
      error_description: "Refresh token has already been revoked",
    });
  });

  test("exposes discovery and JWKS endpoints", async () => {
    const [discoveryResponse, jwksResponse] = await Promise.all([
      authRoutes["/.well-known/openid-configuration"].GET(
        new Request("http://example.test/.well-known/openid-configuration"),
      ),
      authRoutes["/.well-known/jwks.json"].GET(),
    ]);

    expect(discoveryResponse.status).toBe(200);
    expect(await discoveryResponse.json()).toEqual(expect.objectContaining({
      token_endpoint: "http://example.test/api/auth/token",
      device_authorization_endpoint: "http://example.test/api/auth/device",
    }));

    expect(jwksResponse.status).toBe(200);
    expect(await jwksResponse.json()).toEqual({
      keys: [
        expect.objectContaining({
          kid: expect.any(String),
          use: "sig",
        }),
      ],
    });
  });
});
