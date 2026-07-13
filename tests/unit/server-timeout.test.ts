import { expect, test } from "bun:test";
import { settingsRoutes } from "../../src/api/settings";
import { archivedTasksRoutes } from "../../src/api/workspaces/archived-tasks";

const PURGE_ROUTES = [
  settingsRoutes["/api/settings/purge-terminal-tasks"]!.POST!,
  archivedTasksRoutes["/api/workspaces/:id/archived-tasks/purge"]!.POST!,
];

test("disables Bun request idle timeout for both purge routes", async () => {
  for (const handler of PURGE_ROUTES) {
    const request = new Request("http://localhost/api/purge");
    const calls: Array<{ request: Request; seconds: number }> = [];
    const server = {
      timeout(request: Request, seconds: number) {
        calls.push({ request, seconds });
      },
    };

    await handler(request, { server, params: { id: "test-workspace" } } as never);

    expect(calls).toEqual([{ request, seconds: 0 }]);
  }
});
