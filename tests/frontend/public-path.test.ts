import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createLogger } from "../../src/lib/logger";
import { PASSKEY_AUTH_REQUIRED_HEADER } from "../../src/lib/passkey-auth-http";
import {
  appAbsoluteUrl,
  appFetch,
  appPath,
  PASSKEY_AUTH_REQUIRED_EVENT,
  appWebSocketUrl,
  setConfiguredPublicBasePath,
} from "../../src/lib/public-path";

const publicPathLog = createLogger("publicPath");

describe("public path helpers", () => {
  beforeEach(() => {
    setConfiguredPublicBasePath(undefined);
    window.location.href = "https://example.com/";
  });

  afterEach(() => {
    setConfiguredPublicBasePath(undefined);
  });

  test("derives app-local URLs from the current pathname", () => {
    window.location.href = "https://example.com/ralpher/";

    expect(appPath("/api/loops")).toBe("/ralpher/api/loops");
    expect(appAbsoluteUrl("/loop/test-loop/port/test-forward/")).toBe(
      "https://example.com/ralpher/loop/test-loop/port/test-forward/",
    );
    expect(appWebSocketUrl("/api/ws?loopId=test-loop")).toBe(
      "wss://example.com/ralpher/api/ws?loopId=test-loop",
    );
  });

  test("appFetch prefixes local API requests", async () => {
    window.location.href = "https://example.com/ralpher/";

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

    expect(requestedUrls).toEqual(["/ralpher/api/config"]);
  });

  test("appFetch propagates transport failures without logging them locally", async () => {
    window.location.href = "https://example.com/ralpher/";

    const originalFetch = globalThis.fetch;
    const errorSpy = spyOn(publicPathLog, "error").mockImplementation(() => undefined);
    const networkError = new Error("network down");

    globalThis.fetch = ((..._args: Parameters<typeof fetch>) => Promise.reject(networkError)) as typeof fetch;

    try {
      await expect(appFetch("/api/config")).rejects.toThrow("network down");
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });

  test("appFetch dispatches the auth-required event only for passkey-tagged 401 responses", async () => {
    window.location.href = "https://example.com/ralpher/";

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

  test("prefers the configured server-provided base path when available", () => {
    window.location.href = "https://example.com/";
    setConfiguredPublicBasePath("/proxy/");

    expect(appPath("/api/loops")).toBe("/proxy/api/loops");
  });

  test("treats an empty configured base path as not configured", () => {
    window.location.href = "https://example.com/ralpher/";
    setConfiguredPublicBasePath("");

    expect(appPath("/api/loops")).toBe("/ralpher/api/loops");
  });
});
