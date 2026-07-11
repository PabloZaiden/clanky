import { expect, test } from "bun:test";
import { configureLegacyRouteRequestTimeout } from "../../src/server";

const PURGE_ROUTES = [
  "/api/settings/purge-terminal-tasks",
  "/api/workspaces/:id/archived-tasks/purge",
];

test("disables Bun request idle timeout for both purge routes", () => {
  for (const path of PURGE_ROUTES) {
    const request = new Request(`http://localhost${path}`);
    const calls: Array<{ request: Request; seconds: number }> = [];
    const server = {
      timeout(request: Request, seconds: number) {
        calls.push({ request, seconds });
      },
    };

    configureLegacyRouteRequestTimeout(path, request, server);

    expect(calls).toEqual([{ request, seconds: 0 }]);
  }
});

test("does not change request timeout for unrelated routes", () => {
  const calls: Array<{ request: Request; seconds: number }> = [];
  const server = {
    timeout(request: Request, seconds: number) {
      calls.push({ request, seconds });
    },
  };

  configureLegacyRouteRequestTimeout("/api/tasks", new Request("http://localhost/api/tasks"), server);

  expect(calls).toEqual([]);
});
