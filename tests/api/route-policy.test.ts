import { describe, expect, test } from "bun:test";
import { createRouteCatalog, findRouteCatalogEntry } from "@pablozaiden/webapp/server";
import { apiRoutes } from "../../src/api";
import { routes } from "../../src/server";

/**
 * Routes that are intentionally reachable without an authenticated Clanky user.
 *
 * Every entry must have a documented product rationale. Adding a route here is a
 * deliberate decision to expose it to unauthenticated callers, so any new
 * `auth: "public"` route fails this test until it is reviewed and listed.
 *
 * Rationale for the current entries: mesh peers are separate Clanky servers that
 * cannot present a browser session. They authenticate with Ed25519 request
 * signatures and peer identity headers verified inside each handler (covered by
 * `tests/api/mesh-internal.test.ts`), so the framework's user/session policy does
 * not apply to them.
 */
const PUBLIC_ROUTE_ALLOWLIST = [
  "/api/mesh/internal/execution/acp",
  "/api/mesh/internal/execution/file",
  "/api/mesh/internal/execution/rpc",
  "/api/mesh/internal/execution/session",
  "/api/mesh/internal/health",
  "/api/mesh/internal/membership",
  "/api/mesh/internal/pairing-approvals",
  "/api/mesh/internal/pairing-requests",
  "/api/mesh/internal/terminal",
  "/api/mesh/internal/terminal/session",
] as const;

/** Owner-only routes are destructive; downgrading one to `user` must fail the build. */
const OWNER_ROUTE_ALLOWLIST = [
  "/api/settings/purge-terminal-tasks",
  "/api/settings/reset-all",
] as const;

describe("API route policy metadata", () => {
  test("declares authorization, same-origin policy, and route descriptions on every Clanky route", () => {
    const catalog = createRouteCatalog(routes);
    const entries = catalog.filter((entry) => entry.path.startsWith("/api/"));

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const route = routes[entry.path];
      if (!route || !route.auth || !route.sameOrigin) {
        throw new Error(`Route ${entry.path} is missing explicit policy metadata`);
      }
      expect(entry.auth).toBe(route.auth);
      expect(entry.sameOrigin).toBe(route.sameOrigin);
      expect(route.description).toBeTruthy();
      expect(entry.description).toBe(route.description);
    }

    const tasksEntry = findRouteCatalogEntry(catalog, "tasks")?.entry;
    expect(tasksEntry?.path).toBe("/api/tasks");
    expect(tasksEntry?.auth).toBe("user");
    expect(tasksEntry?.sameOrigin).toBe("mutations");
    expect(tasksEntry?.description).toBeTruthy();
  });

  test("keeps public and owner-only routes limited to the reviewed allowlists", () => {
    const declaredRoutes = Object.entries(routes).filter(([path]) => path.startsWith("/api/"));

    const publicPaths = declaredRoutes
      .filter(([, route]) => route?.auth === "public")
      .map(([path]) => path)
      .sort();
    expect(publicPaths).toEqual([...PUBLIC_ROUTE_ALLOWLIST].sort());

    // Unauthenticated routes must also opt out of same-origin enforcement explicitly,
    // otherwise the declared policy pair is inconsistent for non-browser peers.
    for (const path of publicPaths) {
      expect(routes[path]?.sameOrigin).toBe("never");
    }

    const ownerPaths = declaredRoutes
      .filter(([, route]) => route?.auth === "owner")
      .map(([path]) => path)
      .sort();
    expect(ownerPaths).toEqual([...OWNER_ROUTE_ALLOWLIST].sort());
  });

  test("keeps user and websocket policies explicit after composition", () => {
    expect(apiRoutes["/api/tasks"]?.auth).toBe("user");
    expect(apiRoutes["/api/tasks"]?.sameOrigin).toBe("mutations");
    expect(apiRoutes["/api/settings/reset-all"]?.auth).toBe("owner");
    expect(apiRoutes["/api/settings/purge-terminal-tasks"]?.auth).toBe("owner");
    expect(routes["/api/previews/bridge"]?.auth).toBe("user");
    expect(routes["/api/previews/bridge"]?.sameOrigin).toBe("always");
    expect(routes["/api/ssh-terminal"]?.auth).toBe("user");
    expect(routes["/api/ssh-terminal"]?.sameOrigin).toBe("always");
    expect(routes["/api/vnc"]?.auth).toBe("user");
    expect(routes["/api/vnc"]?.sameOrigin).toBe("always");
  });
});
