import { describe, expect, test } from "bun:test";
import type { WebAppCliCommandContext } from "@pablozaiden/webapp/cli";
import {
  parseServerCommandArgs,
  runServerCommand,
} from "../../src/cli/server";
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
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const fetchFn = createFetch((url, init) => {
      requests.push({ url, init });
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-api-key");
      if (url.pathname === "/api/execution-hosts") {
        return Response.json([{
          ref: { kind: "mesh", nodeId: "worker-1" },
          targetKey: "mesh:worker-1",
          name: "Diagnostics worker",
          endpoint: "https://worker.example",
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
    expect(requests[1]?.url.pathname).toBe("/api/execution-hosts/mesh/worker-1/exec");
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      command: "tail",
      args: ["-n", "2", "server.log"],
      cwd: "logs",
      timeoutMs: 5000,
    });
  });

  test("parses a serialized execution-host reference and SSH credential token", () => {
    expect(parseServerCommandArgs([
      "exec",
      "mesh:worker-1",
      "--credential-token=temporary-token",
      "--",
      "uname",
      "-a",
    ])).toEqual({
      operation: "exec",
      server: "mesh:worker-1",
      cwd: undefined,
      timeoutMs: undefined,
      credentialToken: "temporary-token",
      command: "uname",
      args: ["-a"],
    });
  });
});
