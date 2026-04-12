import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as passkeyAuthCore from "../../src/core/passkey-auth";
import { createLogger } from "../../src/core/logger";
import { PASSKEY_AUTH_REQUIRED_HEADER } from "../../src/lib/passkey-auth-http";
import { passkeyAuthRoutes } from "../../src/api/passkey-auth";
import { setupTestContext, teardownTestContext } from "../setup";

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
