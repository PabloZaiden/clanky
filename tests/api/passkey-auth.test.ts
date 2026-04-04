import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as passkeyAuthCore from "../../src/core/passkey-auth";
import { createLogger } from "../../src/core/logger";
import { PASSKEY_AUTH_REQUIRED_HEADER } from "../../src/lib/passkey-auth-http";
import { passkeyAuthRoutes } from "../../src/api/passkey-auth";

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
