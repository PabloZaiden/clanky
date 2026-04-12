import { describe, expect, test } from "bun:test";
import {
  checkRequestSameOrigin,
  getEffectiveRequestOriginInfo,
  getRequestOriginInfo,
} from "../../src/utils/request-origin";

describe("getRequestOriginInfo", () => {
  test("prefers the browser origin header over the backend request URL", () => {
    const info = getRequestOriginInfo(
      new Request("http://internal-host:3000/api/passkey-auth/registration/verify", {
        headers: {
          origin: "https://ralpher.example.test:12443",
          host: "internal-host:3000",
        },
      }),
    );

    expect(info).toEqual({
      origin: "https://ralpher.example.test:12443",
      hostname: "ralpher.example.test",
      secure: true,
    });
  });

  test("falls back to the browser referer when origin is not present", () => {
    const info = getRequestOriginInfo(
      new Request("http://internal-host:3000/api/passkey-auth/registration/options", {
        headers: {
          referer: "https://ralpher.example.test:12443/settings",
          host: "internal-host:3000",
        },
      }),
    );

    expect(info).toEqual({
      origin: "https://ralpher.example.test:12443",
      hostname: "ralpher.example.test",
      secure: true,
    });
  });

  test("uses forwarded proxy headers when browser headers are unavailable", () => {
    const info = getRequestOriginInfo(
      new Request("http://internal-host:3000/api/passkey-auth/registration/options", {
        headers: {
          "x-forwarded-host": "ralpher.example.test:12443",
          "x-forwarded-proto": "https",
        },
      }),
    );

    expect(info).toEqual({
      origin: "https://ralpher.example.test:12443",
      hostname: "ralpher.example.test",
      secure: true,
    });
  });
});

describe("getEffectiveRequestOriginInfo", () => {
  test("uses forwarded proxy headers instead of the browser origin header", () => {
    const info = getEffectiveRequestOriginInfo(
      new Request("http://internal-host:3000/api/passkey-auth/authentication/verify", {
        headers: {
          origin: "https://attacker.example.test",
          "x-forwarded-host": "ralpher.example.test:12443",
          "x-forwarded-proto": "https",
        },
      }),
    );

    expect(info).toEqual({
      origin: "https://ralpher.example.test:12443",
      hostname: "ralpher.example.test",
      secure: true,
    });
  });

  test("falls back to the request URL when forwarded headers are malformed", () => {
    const info = getEffectiveRequestOriginInfo(
      new Request("https://ralpher.example.test/api/passkey-auth/authentication/verify", {
        headers: {
          "x-forwarded-host": "bad host value",
          "x-forwarded-proto": "ftp",
        },
      }),
    );

    expect(info).toEqual({
      origin: "https://ralpher.example.test",
      hostname: "ralpher.example.test",
      secure: true,
    });
  });
});

describe("checkRequestSameOrigin", () => {
  test("accepts a matching Origin header", () => {
    const result = checkRequestSameOrigin(
      new Request("http://internal-host:3000/api/loops", {
        method: "POST",
        headers: {
          origin: "https://ralpher.example.test:12443",
          "x-forwarded-host": "ralpher.example.test:12443",
          "x-forwarded-proto": "https",
        },
      }),
    );

    expect(result).toEqual({
      allowed: true,
      expectedOrigin: "https://ralpher.example.test:12443",
      actualOrigin: "https://ralpher.example.test:12443",
      source: "origin",
    });
  });

  test("falls back to Referer when Origin is missing", () => {
    const result = checkRequestSameOrigin(
      new Request("http://internal-host:3000/api/loops", {
        method: "POST",
        headers: {
          referer: "https://ralpher.example.test:12443/app/settings",
          "x-forwarded-host": "ralpher.example.test:12443",
          "x-forwarded-proto": "https",
        },
      }),
    );

    expect(result).toEqual({
      allowed: true,
      expectedOrigin: "https://ralpher.example.test:12443",
      actualOrigin: "https://ralpher.example.test:12443",
      source: "referer",
    });
  });

  test("rejects a foreign Origin header", () => {
    const result = checkRequestSameOrigin(
      new Request("http://internal-host:3000/api/loops", {
        method: "POST",
        headers: {
          origin: "https://attacker.example.test",
          "x-forwarded-host": "ralpher.example.test:12443",
          "x-forwarded-proto": "https",
        },
      }),
    );

    expect(result).toEqual({
      allowed: false,
      expectedOrigin: "https://ralpher.example.test:12443",
      actualOrigin: "https://attacker.example.test",
      source: "origin",
      reason: "mismatch",
    });
  });

  test("rejects requests when both Origin and Referer are missing", () => {
    const result = checkRequestSameOrigin(
      new Request("https://ralpher.example.test/api/loops", {
        method: "POST",
      }),
    );

    expect(result).toEqual({
      allowed: false,
      expectedOrigin: "https://ralpher.example.test",
      reason: "missing",
    });
  });
});
