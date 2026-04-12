import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createHmac } from "node:crypto";
import * as passkeyAuthCore from "../../src/core/passkey-auth";
import { createLogger } from "../../src/core/logger";
import { getOrCreatePasskeyAuthSecret, getPasskeyAuthVersion, savePasskey } from "../../src/persistence/passkey-auth";
import { PASSKEY_AUTH_REQUIRED_HEADER } from "../../src/lib/passkey-auth-http";
import { passkeyAuthRoutes } from "../../src/api/passkey-auth";
import { setupTestContext, teardownTestContext } from "../setup";

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

describe("passkey auth routes", () => {
  afterEach(() => {
    mock.restore();
  });

  test("returns a generic 500 response for unexpected passkey auth failures", async () => {
    const apiLog = createLogger("api:passkey-auth");
    const errorSpy = spyOn(apiLog, "error").mockImplementation(() => undefined);
    spyOn(passkeyAuthCore, "beginPasskeyRegistration").mockRejectedValue(new Error("internal secret details"));

    const response = await passkeyAuthRoutes["/api/passkey-auth/registration/options"].GET(
      new Request("http://example.test/api/passkey-auth/registration/options"),
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "passkey_auth_failed",
      message: "An unexpected error occurred",
    });
    expect(errorSpy).toHaveBeenCalled();
  });

  test("tags passkey-auth-required API responses with the dedicated header", async () => {
    spyOn(passkeyAuthCore, "isPasskeyAuthRequired").mockResolvedValue(true);
    spyOn(passkeyAuthCore, "isPasskeySessionAuthenticated").mockResolvedValue(false);

    const response = await passkeyAuthRoutes["/api/passkey-auth/passkey"].DELETE(
      new Request("http://example.test/api/passkey-auth/passkey"),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get(PASSKEY_AUTH_REQUIRED_HEADER)).toBe("true");
    expect(await response.json()).toEqual({
      error: "authentication_required",
      message: "Passkey authentication is required",
    });
  });

  test("reissues existing authenticated sessions on status responses without forcing re-login", async () => {
    const context = await setupTestContext();

    try {
      await savePasskey({
        id: "pk-1",
        name: "Primary passkey",
        credentialId: "credential-1",
        publicKey: new Uint8Array([1, 2, 3]),
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
      });

      const secret = await getOrCreatePasskeyAuthSecret();
      const version = await getPasskeyAuthVersion();
      const remainingSeconds = 15 * 60;
      const cookie = createSignedPasskeySessionCookie({
        nonce: "existing-session",
        version,
        expiresAt: Date.now() + remainingSeconds * 1000,
      }, secret);

      const response = await passkeyAuthRoutes["/api/passkey-auth/status"].GET(
        new Request("http://internal-host:3000/api/passkey-auth/status", {
          headers: {
            cookie,
            "x-forwarded-host": "ralpher.example.test",
            "x-forwarded-proto": "https",
          },
        }),
      );

      const setCookie = response.headers.get("set-cookie");

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        passkeyConfigured: true,
        passkeyDisabled: false,
        passkeyRequired: true,
        authenticated: true,
      });
      expect(setCookie).toContain("ralpher_passkey_session=");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("Secure");

      const maxAgeMatch = setCookie?.match(/Max-Age=(\d+)/);
      expect(maxAgeMatch).not.toBeNull();
      const refreshedMaxAge = Number(maxAgeMatch?.[1]);
      expect(refreshedMaxAge).toBeLessThanOrEqual(remainingSeconds);
      expect(refreshedMaxAge).toBeGreaterThanOrEqual(remainingSeconds - 2);
    } finally {
      await teardownTestContext(context);
    }
  });
});

describe("passkey auth cookies", () => {
  test("uses SameSite=Strict and Secure for HTTPS-derived passkey cookies", async () => {
    const context = await setupTestContext();

    try {
      const registration = await passkeyAuthCore.beginPasskeyRegistration(
        new Request("http://internal-host:3000/api/passkey-auth/registration/options", {
          headers: {
            "x-forwarded-host": "ralpher.example.test",
            "x-forwarded-proto": "https",
          },
        }),
      );
      const logoutHeaders = passkeyAuthCore.createPasskeyLogoutHeaders(
        new Request("http://internal-host:3000/api/passkey-auth/logout", {
          headers: {
            "x-forwarded-host": "ralpher.example.test",
            "x-forwarded-proto": "https",
          },
        }),
      );

      const challengeCookie = registration.headers.get("set-cookie");
      const clearedCookies = logoutHeaders.getSetCookie();

      expect(challengeCookie).toContain("SameSite=Strict");
      expect(challengeCookie).toContain("Secure");
      expect(clearedCookies).toHaveLength(2);
      for (const cookie of clearedCookies) {
        expect(cookie).toContain("SameSite=Strict");
        expect(cookie).toContain("Secure");
      }
    } finally {
      await teardownTestContext(context);
    }
  });

  test("keeps localhost HTTP passkey cookies without Secure", async () => {
    const context = await setupTestContext();

    try {
      const registration = await passkeyAuthCore.beginPasskeyRegistration(
        new Request("http://localhost/api/passkey-auth/registration/options"),
      );
      const logoutHeaders = passkeyAuthCore.createPasskeyLogoutHeaders(
        new Request("http://localhost/api/passkey-auth/logout"),
      );

      const challengeCookie = registration.headers.get("set-cookie");
      const clearedCookies = logoutHeaders.getSetCookie();

      expect(challengeCookie).toContain("SameSite=Strict");
      expect(challengeCookie).not.toContain("Secure");
      expect(clearedCookies).toHaveLength(2);
      for (const cookie of clearedCookies) {
        expect(cookie).toContain("SameSite=Strict");
        expect(cookie).not.toContain("Secure");
      }
    } finally {
      await teardownTestContext(context);
    }
  });
});
