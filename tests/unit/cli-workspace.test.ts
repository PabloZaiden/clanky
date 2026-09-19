import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    const fetchFn = createFetch((url, init) => {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-api-key");
      if (url.pathname === "/api/workspaces") {
        return Response.json([{
          id: "ws-1",
          name: "Build workspace",
          directory: "/workspace/repo",
        }]);
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
  });

  test("streams a binary download to the requested local destination", async () => {
    const destinationDirectory = await mkdtemp(join(tmpdir(), "clanky-workspace-download-"));
    try {
      const remoteBytes = new Uint8Array([0, 1, 2, 127, 128, 255]);
      const fetchFn = createFetch((url) => {
        if (url.pathname === "/api/workspaces") {
          return Response.json([{
            id: "ws-1",
            name: "Build workspace",
            directory: "/workspace/repo",
          }]);
        }
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
      expect(stdoutChunks).toEqual([]);
      expect(stderrChunks).toEqual([]);
    } finally {
      await rm(destinationDirectory, { recursive: true, force: true });
    }
  });

  test("uploads binary chunks to an absolute remote destination", async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), "clanky-workspace-upload-"));
    try {
      const sourcePath = join(sourceDirectory, "artifact.bin");
      const sourceBytes = Uint8Array.from(
        { length: 8 * 1024 * 1024 + 7 },
        (_, index) => index % 256,
      );
      await writeFile(sourcePath, sourceBytes);

      const uploadedChunks: Uint8Array[] = [];
      let firstChunkFailureReturned = false;
      const fetchFn = createFetch(async (url, init) => {
        if (url.pathname === "/api/workspaces") {
          return Response.json([{
            id: "ws-1",
            name: "Build workspace",
            directory: "/workspace/repo",
          }]);
        }
        if (url.pathname.endsWith("/files/upload")) {
          return Response.json({ uploadId: "upload-1" }, { status: 201 });
        }
        if (url.pathname.endsWith("/files/upload/chunk")) {
          const offset = Number(url.searchParams.get("offset"));
          if (offset === 0 && !firstChunkFailureReturned) {
            firstChunkFailureReturned = true;
            return Response.json({ error: "temporary peer failure" }, { status: 503 });
          }
          const bytes = new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
          uploadedChunks.push(bytes);
          return Response.json({
            success: true,
            uploadId: "upload-1",
            bytesWritten: bytes.byteLength,
            nextOffset: offset + bytes.byteLength,
          });
        }
        if (url.pathname.endsWith("/files/upload/complete")) {
          return Response.json({
            success: true,
            file: { path: "artifact.bin" },
            overwritten: true,
          });
        }
        throw new Error(`Unexpected request: ${url.pathname}`);
      });
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      const result = await runWorkspaceCommand(createWorkspaceContext(
        [
          "upload",
          "Build workspace",
          sourcePath,
          "--remote-path",
          "/tmp/uploads/artifact.bin",
          "--force",
        ],
        fetchFn,
        stdoutChunks,
        stderrChunks,
      ));

      expect(result).toEqual({ exitCode: 0 });
      const uploadedBytes = new Uint8Array(
        uploadedChunks.reduce((total, chunk) => total + chunk.byteLength, 0),
      );
      let uploadedOffset = 0;
      for (const chunk of uploadedChunks) {
        uploadedBytes.set(chunk, uploadedOffset);
        uploadedOffset += chunk.byteLength;
      }
      expect(uploadedBytes).toEqual(sourceBytes);
      expect(stdoutChunks).toEqual([`Uploaded ${sourcePath} to /tmp/uploads/artifact.bin\n`]);
      expect(stderrChunks).toEqual([]);
    } finally {
      await rm(sourceDirectory, { recursive: true, force: true });
    }
  });

});
