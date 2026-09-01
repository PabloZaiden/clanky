import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type {
  CliCommandResult,
  WebAppCliCommandContext,
} from "@pablozaiden/webapp/cli";
import { runWorkspaceCommand } from "../../src/cli/workspace";
import type { ClankyCliContext } from "../../src/cli/mesh";

function createWorkspaceContext(
  args: string[],
  fetchFn: typeof fetch,
  stdoutChunks: string[],
  stderrChunks: string[],
): WebAppCliCommandContext<ClankyCliContext> {
  const credentials = {
    read: async () => undefined,
  };
  return {
    command: "workspace",
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
    ): Promise<Response> => {
      return await onRequest(new URL(String(input)), init);
    },
    { preconnect: fetch.preconnect },
  );
}

describe("CLI workspace commands", () => {
  test("executes by exact workspace name and preserves stdout, stderr, and exit code", async () => {
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const fetchFn = createFetch((url, init) => {
      requests.push({ url, init });
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-api-key");
      if (url.pathname === "/api/workspaces") {
        return Response.json([{ id: "ws-1", name: "Build workspace" }]);
      }
      return Response.json({
        workspaceId: "ws-1",
        success: false,
        stdout: "partial output\n",
        stderr: "command failed\n",
        exitCode: 7,
      });
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const result = await runWorkspaceCommand(createWorkspaceContext(
      ["exec", "Build workspace", "--cwd", "/tmp", "--", "git", "status", "--short"],
      fetchFn,
      stdoutChunks,
      stderrChunks,
    ));

    expect(result).toEqual({ exitCode: 7 });
    expect(stdoutChunks).toEqual(["partial output\n"]);
    expect(stderrChunks).toEqual(["command failed\n"]);
    expect(requests[1]?.url.pathname).toBe("/api/workspaces/ws-1/exec");
    expect(JSON.parse(String(requests[1]?.init.body))).toEqual({
      command: "git",
      args: ["status", "--short"],
      cwd: "/tmp",
    });
  });

  test("streams a binary download to the requested local destination", async () => {
    const destinationDirectory = await mkdtemp(join(tmpdir(), "clanky-workspace-download-"));
    try {
      const remoteBytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
      let downloadUrl: URL | undefined;
      const fetchFn = createFetch((url) => {
        if (url.pathname === "/api/workspaces") {
          return Response.json([{ id: "ws-1", name: "Build workspace" }]);
        }
        downloadUrl = url;
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(remoteBytes);
            controller.close();
          },
        }), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        });
      });
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      const destination = join(destinationDirectory, "report.bin");
      const result: CliCommandResult = await runWorkspaceCommand(createWorkspaceContext(
        ["download", "Build workspace", "/tmp/report with space.bin", "--output", destination],
        fetchFn,
        stdoutChunks,
        stderrChunks,
      ));

      expect(result).toEqual({ exitCode: 0 });
      expect(new Uint8Array(await readFile(destination))).toEqual(remoteBytes);
      expect(downloadUrl?.pathname).toBe("/api/workspaces/ws-1/files/download");
      expect(downloadUrl?.searchParams.get("path")).toBe("/tmp/report with space.bin");
      expect(stdoutChunks).toEqual([]);
      expect(stderrChunks).toEqual([]);
    } finally {
      await rm(destinationDirectory, { recursive: true, force: true });
    }
  });
});
