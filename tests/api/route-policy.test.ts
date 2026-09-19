import { describe, expect, test } from "bun:test";
import { createRouteCatalog, findRouteCatalogEntry } from "@pablozaiden/webapp/server";
import { apiRoutes } from "../../src/api";
import { routes } from "../../src/server";
import { MESH_RELAY_DESCRIPTOR_PATH } from "../../src/shared/mesh-relay";

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
  "/api/mesh/internal/enrollment",
] as const;

/** Owner-only routes are destructive; downgrading one to `user` must fail the build. */
const OWNER_ROUTE_ALLOWLIST = [
  "/api/execution-hosts/:kind/:id/configuration",
  "/api/mesh/enrollment-tokens",
  "/api/mesh/endpoint",
  "/api/mesh/enroll",
  "/api/mesh/health",
  "/api/mesh/instance-name",
  "/api/mesh/relay",
  "/api/mesh/workers/:workerNodeId",
  "/api/mesh/workers/:workerNodeId/kill",
  "/api/mesh/workers/revoke",
  "/api/settings/purge-terminal-tasks",
  "/api/settings/reset-all",
] as const;

type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

const AGENT_ROUTE_SURFACE = {
  "/api/agents": ["GET", "POST"],
  "/api/agents/code/generate": ["POST"],
  "/api/agents/:id/export": ["GET"],
  "/api/workspaces/:id/agents/import": ["POST"],
  "/api/agents/:id": ["GET", "PATCH", "DELETE"],
  "/api/agents/:id/code/draft": ["GET"],
  "/api/agents/:id/code/generate/prepare": ["POST"],
  "/api/agents/:id/code/generate": ["POST"],
  "/api/agents/code/test": ["POST"],
  "/api/agents/code/test/stream": ["POST"],
  "/api/agents/:id/run": ["POST"],
  "/api/agents/:id/interrupt": ["POST"],
  "/api/agents/:id/pause": ["POST"],
  "/api/agents/:id/resume": ["POST"],
  "/api/agents/:id/runs": ["GET", "DELETE"],
  "/api/agent-runs/:id": ["GET", "DELETE"],
  "/api/agent-runs/:id/snapshot": ["GET"],
  "/api/agent-runs/:id/tool-calls/:toolCallId": ["GET"],
} as const satisfies Record<string, readonly ApiMethod[]>;

const API_METHODS: readonly ApiMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

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

  test("preserves the complete scheduled-agent route surface after composition", () => {
    const expectedPaths = Object.keys(AGENT_ROUTE_SURFACE).sort();
    const actualPaths = Object.keys(apiRoutes)
      .filter((path) => (
        path === "/api/agents"
        || path.startsWith("/api/agents/")
        || path.startsWith("/api/agent-runs/")
        || path === "/api/workspaces/:id/agents/import"
      ))
      .sort();
    expect(actualPaths).toEqual(expectedPaths);

    for (const path of expectedPaths) {
      const route = apiRoutes[path];
      if (!route) {
        throw new Error(`Missing scheduled-agent route: ${path}`);
      }
      const expectedMethods = AGENT_ROUTE_SURFACE[path as keyof typeof AGENT_ROUTE_SURFACE];
      const actualMethods = API_METHODS.filter((method) => route[method] !== undefined);
      expect(actualMethods).toEqual([...expectedMethods]);
      expect(route.auth).toBe("user");
      expect(route.sameOrigin).toBe("mutations");
      expect(route.description).toBeTruthy();
    }
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
    expect(routes[MESH_RELAY_DESCRIPTOR_PATH]?.auth).toBe("public");
    expect(routes[MESH_RELAY_DESCRIPTOR_PATH]?.sameOrigin).toBe("never");
    expect(apiRoutes["/api/tasks"]?.auth).toBe("user");
    expect(apiRoutes["/api/tasks"]?.sameOrigin).toBe("mutations");
    expect(apiRoutes["/api/settings/reset-all"]?.auth).toBe("owner");
    expect(apiRoutes["/api/settings/purge-terminal-tasks"]?.auth).toBe("owner");
    expect(routes["/api/previews/bridge"]?.auth).toBe("user");
    expect(routes["/api/previews/bridge"]?.sameOrigin).toBe("always");
    expect(routes["/api/vnc"]?.auth).toBe("user");
    expect(routes["/api/vnc"]?.sameOrigin).toBe("always");
  });
});
