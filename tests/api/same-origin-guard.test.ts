import { describe, expect, test } from "bun:test";
import {
  wrapRouteHandlerWithSameOriginProtection,
  wrapRoutesWithSameOriginProtection,
} from "../../src/api/same-origin-guard";

describe("same-origin guard", () => {
  test("returns 403 for mutating requests with a foreign Origin header", async () => {
    const wrappedRoutes = wrapRoutesWithSameOriginProtection({
      "/api/loops": {
        POST: async () => Response.json({ ok: true }),
      },
    });
    const route = wrappedRoutes["/api/loops"] as {
      POST: (req: Request) => Promise<Response>;
    };

    const response = await route.POST(new Request("https://ralpher.example.test/api/loops", {
      method: "POST",
      headers: {
        origin: "https://attacker.example.test",
      },
    }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "invalid_request_origin",
      message: "Origin or Referer must match the request origin",
    });
  });

  test("accepts mutating requests with a matching Origin header", async () => {
    const wrappedRoutes = wrapRoutesWithSameOriginProtection({
      "/api/loops": {
        POST: async () => Response.json({ ok: true }),
      },
    });
    const route = wrappedRoutes["/api/loops"] as {
      POST: (req: Request) => Promise<Response>;
    };

    const response = await route.POST(new Request("https://ralpher.example.test/api/loops", {
      method: "POST",
      headers: {
        origin: "https://ralpher.example.test",
      },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("allows cross-origin mutating requests when protection is disabled", async () => {
    const wrappedRoutes = wrapRoutesWithSameOriginProtection({
      "/api/loops": {
        POST: async () => Response.json({ ok: true }),
      },
    }, {
      disabled: true,
    });
    const route = wrappedRoutes["/api/loops"] as {
      POST: (req: Request) => Promise<Response>;
    };

    const response = await route.POST(new Request("https://ralpher.example.test/api/loops", {
      method: "POST",
      headers: {
        origin: "https://attacker.example.test",
      },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("falls back to Referer when Origin is missing", async () => {
    const wrappedRoutes = wrapRoutesWithSameOriginProtection({
      "/api/loops": {
        DELETE: async () => Response.json({ ok: true }),
      },
    });
    const route = wrappedRoutes["/api/loops"] as {
      DELETE: (req: Request) => Promise<Response>;
    };

    const response = await route.DELETE(new Request("https://ralpher.example.test/api/loops", {
      method: "DELETE",
      headers: {
        referer: "https://ralpher.example.test/dashboard",
      },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("does not require origin headers for normal GET requests", async () => {
    const wrappedRoutes = wrapRoutesWithSameOriginProtection({
      "/api/loops": {
        GET: async () => Response.json({ ok: true }),
      },
    });
    const route = wrappedRoutes["/api/loops"] as {
      GET: (req: Request) => Promise<Response>;
    };

    const response = await route.GET(new Request("https://ralpher.example.test/api/loops"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test("rejects websocket upgrades on cross-origin requests before upgrade", async () => {
    let upgradeCalled = false;
    const wrappedHandler = wrapRouteHandlerWithSameOriginProtection(
      (_req: Request, server: { upgrade: () => boolean }) => {
        upgradeCalled = true;
        server.upgrade();
        return undefined;
      },
      { alwaysProtect: true },
    );

    const response = await wrappedHandler(
      new Request("https://ralpher.example.test/api/ws", {
        headers: {
          origin: "https://attacker.example.test",
        },
      }),
      { upgrade: () => true },
    );

    expect(response?.status).toBe(403);
    expect(upgradeCalled).toBe(false);
  });

  test("protects websocket upgrade requests for wrapped function routes", async () => {
    let handlerCalled = false;
    const wrappedRoutes = wrapRoutesWithSameOriginProtection({
      "/loop/:loopId/port/:forwardId": async () => {
        handlerCalled = true;
        return Response.json({ ok: true });
      },
    });
    const route = wrappedRoutes["/loop/:loopId/port/:forwardId"] as (req: Request) => Promise<Response | undefined>;

    const response = await route(new Request("https://ralpher.example.test/loop/test/port/test", {
      headers: {
        origin: "https://attacker.example.test",
        upgrade: "websocket",
      },
    }));

    expect(response?.status).toBe(403);
    expect(handlerCalled).toBe(false);
  });

  test("allows websocket upgrades when protection is disabled", async () => {
    let upgradeCalled = false;
    const wrappedHandler = wrapRouteHandlerWithSameOriginProtection(
      (_req: Request, server: { upgrade: () => boolean }) => {
        upgradeCalled = true;
        server.upgrade();
        return undefined;
      },
      {
        alwaysProtect: true,
        disabled: true,
      },
    );

    const response = await wrappedHandler(
      new Request("https://ralpher.example.test/api/ws", {
        headers: {
          origin: "https://attacker.example.test",
        },
      }),
      { upgrade: () => true },
    );

    expect(response).toBeUndefined();
    expect(upgradeCalled).toBe(true);
  });
});
