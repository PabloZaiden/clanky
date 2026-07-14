import { describe, expect, test } from "bun:test";
import { createRouteCatalog } from "@pablozaiden/webapp/server";
import { apiRoutes } from "../../src/api";
import { findApiEndpoint, getCliRouteCatalog } from "../../src/cli/api-catalog";
import { routes } from "../../src/server";

describe("API route policy metadata", () => {
  test("declares authorization, same-origin policy, and route descriptions on every Clanky route", () => {
    const entries = createRouteCatalog(routes).filter((entry) => entry.path.startsWith("/api/"));

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
  });

  test("keeps owner-only settings and websocket policies explicit after composition", () => {
    expect(apiRoutes["/api/tasks"]?.auth).toBe("user");
    expect(apiRoutes["/api/tasks"]?.sameOrigin).toBe("mutations");
    expect(apiRoutes["/api/settings/reset-all"]?.auth).toBe("owner");
    expect(apiRoutes["/api/settings/purge-terminal-tasks"]?.auth).toBe("owner");
    expect(routes["/api/previews/bridge"]?.auth).toBe("user");
    expect(routes["/api/previews/bridge"]?.sameOrigin).toBe("always");
    expect(routes["/api/ssh-terminal"]?.sameOrigin).toBe("always");
    expect(routes["/api/vnc"]?.sameOrigin).toBe("always");
  });

  test("exposes the declared policy through CLI catalog lookup", () => {
    const entry = findApiEndpoint("tasks")!;
    const catalog = getCliRouteCatalog();

    expect(catalog).toContainEqual(entry);
    expect(entry.path).toBe("/api/tasks");
    expect(entry.auth).toBe("user");
    expect(entry.sameOrigin).toBe("mutations");
    expect(entry.description).toBeTruthy();
  });
});
