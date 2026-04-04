import { describe, expect, test } from "bun:test";
import { getRequestOriginInfo } from "../../src/utils/request-origin";

describe("getRequestOriginInfo", () => {
  test("prefers the browser origin header over the backend request URL", () => {
    const info = getRequestOriginInfo(
      new Request("http://internal-host:3000/api/passkey-auth/registration/verify", {
        headers: {
          origin: "https://ralpher.zaiden.duckdns.org:12443",
          host: "internal-host:3000",
        },
      }),
    );

    expect(info).toEqual({
      origin: "https://ralpher.zaiden.duckdns.org:12443",
      hostname: "ralpher.zaiden.duckdns.org",
      secure: true,
    });
  });

  test("falls back to the browser referer when origin is not present", () => {
    const info = getRequestOriginInfo(
      new Request("http://internal-host:3000/api/passkey-auth/registration/options", {
        headers: {
          referer: "https://ralpher.zaiden.duckdns.org:12443/settings",
          host: "internal-host:3000",
        },
      }),
    );

    expect(info).toEqual({
      origin: "https://ralpher.zaiden.duckdns.org:12443",
      hostname: "ralpher.zaiden.duckdns.org",
      secure: true,
    });
  });

  test("uses forwarded proxy headers when browser headers are unavailable", () => {
    const info = getRequestOriginInfo(
      new Request("http://internal-host:3000/api/passkey-auth/registration/options", {
        headers: {
          "x-forwarded-host": "ralpher.zaiden.duckdns.org:12443",
          "x-forwarded-proto": "https",
        },
      }),
    );

    expect(info).toEqual({
      origin: "https://ralpher.zaiden.duckdns.org:12443",
      hostname: "ralpher.zaiden.duckdns.org",
      secure: true,
    });
  });
});
