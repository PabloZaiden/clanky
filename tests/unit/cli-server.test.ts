import { describe, expect, test } from "bun:test";
import type { WebAppCliCommandContext } from "@pablozaiden/webapp/cli";
import { runServerCommand } from "../../src/cli/server";
import type { ClankyCliContext } from "../../src/cli/mesh";

function createServerContext(
  args: string[],
  fetchFn: typeof fetch,
  stdoutChunks: string[],
  stderrChunks: string[],
): WebAppCliCommandContext<ClankyCliContext> {
  const credentials = {
    read: async () => undefined,
  };
  return {
    command: "server",
    args,
    profile: "default",
    profiles: {
      credentials: () => credentials,
    } as unknown as WebAppCliCommandContext<ClankyCliContext>["profiles"],
    envPrefix: "CLANKY",
    environment: {
      CLANKY_BASE_URL: "https://clanky.example",
      CLANKY_API_KEY: "test-api-key",
    },
    fetchFn,
    stdin: {} as WebAppCliCommandContext<ClankyCliContext>["stdin"],
    stdout: {
      write(chunk: string) {
        stdoutChunks.push(chunk);
      },
    },
    stderr: {
      write(chunk: string) {
        stderrChunks.push(chunk);
      },
    },
    appContext: {
      routeCatalog: [],
    },
  };
}

function createFetch(
  onRequest: (url: URL, init: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return Object.assign(
    async (
      input: Parameters<typeof fetch>[0],
      init: Parameters<typeof fetch>[1] = {},
    ): Promise<Response> => await onRequest(new URL(String(input)), init),
    { preconnect: fetch.preconnect },
  );
}

describe("CLI server commands", () => {
  test("executes by exact host name and preserves remote output and exit code", async () => {
    const fetchFn = createFetch((url, init) => {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-api-key");
      if (url.pathname === "/api/execution-hosts") {
        return Response.json([{
          ref: { kind: "mesh", nodeId: "worker-1" },
          targetKey: "mesh:worker-1",
          name: "Diagnostics worker",
          endpoint: "https://worker.example",
          meshRouteKind: "direct",
          repositoriesBasePath: "/srv",
          preferredModel: null,
          configurationRevision: 1,
          accessRequirement: { kind: "none" },
          acceptRemoteExecution: true,
          capabilities: {},
          revision: 1,
        }]);
      }
      return Response.json({
        executionHost: "mesh:worker-1",
        success: false,
        stdout: "partial output\n",
        stderr: "command failed\n",
        exitCode: 9,
      });
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const result = await runServerCommand(createServerContext(
      ["exec", "Diagnostics worker", "--cwd", "logs", "--timeout", "5000", "--", "tail", "-n", "2", "server.log"],
      fetchFn,
      stdoutChunks,
      stderrChunks,
    ));

    expect(result).toEqual({ exitCode: 9 });
    expect(stdoutChunks).toEqual(["partial output\n"]);
    expect(stderrChunks).toEqual(["command failed\n"]);
  });

});
