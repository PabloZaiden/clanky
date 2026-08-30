import { expect, test } from "bun:test";
import { settingsRoutes } from "../../src/api/settings";
import { archivedTasksRoutes } from "../../src/api/workspaces/archived-tasks";

const LONG_RUNNING_CLEANUP_ROUTES = [
  settingsRoutes["/api/settings/purge-terminal-tasks"]!.POST!,
  archivedTasksRoutes["/api/workspaces/:id/archived-tasks/purge"]!.POST!,
];

test("disables Bun request idle timeout for long-running cleanup routes", async () => {
  for (const handler of LONG_RUNNING_CLEANUP_ROUTES) {
    const request = new Request("http://localhost/api/purge");
    const calls: Array<{ request: Request; seconds: number }> = [];
    const timeoutCaptured = new Error("request timeout captured");
    const server = {
      timeout(request: Request, seconds: number) {
        calls.push({ request, seconds });
        throw timeoutCaptured;
      },
    };

    await expect(handler(request, { server, params: { id: "test-workspace" } } as never)).rejects.toBe(timeoutCaptured);

    expect(calls).toEqual([{ request, seconds: 0 }]);
  }
});
