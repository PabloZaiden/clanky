import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PASSKEY_AUTH_REQUIRED_HEADER } from "../../src/lib/passkey-auth-http";
import {
  appFetch,
  PASSKEY_AUTH_REQUIRED_EVENT,
  setConfiguredPublicBasePath,
} from "../../src/lib/public-path";

describe("public path helpers", () => {
  beforeEach(() => {
    setConfiguredPublicBasePath(undefined);
    window.location.href = "https://example.com/";
  });

  afterEach(() => {
    setConfiguredPublicBasePath(undefined);
  });

  test("appFetch prefixes local API requests", async () => {
    window.location.href = "https://example.com/clanky/";

    const originalFetch = globalThis.fetch;
    const requestedUrls: string[] = [];
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      requestedUrls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch;

    try {
      await appFetch("/api/config");
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestedUrls).toEqual(["/clanky/api/config"]);
  });

  test("appFetch dispatches the auth-required event only for passkey-tagged 401 responses", async () => {
    window.location.href = "https://example.com/clanky/";

    const originalFetch = globalThis.fetch;
    const receivedEventTypes: string[] = [];
    const handleAuthRequired = (event: Event) => {
      receivedEventTypes.push(event.type);
    };

    window.addEventListener(PASSKEY_AUTH_REQUIRED_EVENT, handleAuthRequired);
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.endsWith("/plain-401")) {
        return Promise.resolve(new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }));
      }

      return Promise.resolve(new Response(JSON.stringify({ error: "authentication_required" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          [PASSKEY_AUTH_REQUIRED_HEADER]: "true",
        },
      }));
    }) as typeof fetch;

    try {
      await appFetch("/plain-401");
      await appFetch("/flagged-401");
    } finally {
      window.removeEventListener(PASSKEY_AUTH_REQUIRED_EVENT, handleAuthRequired);
      globalThis.fetch = originalFetch;
    }

    expect(receivedEventTypes).toEqual([PASSKEY_AUTH_REQUIRED_EVENT]);
  });
});
