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
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const fetchFn = createFetch((url, init) => {
      requests.push({ url, init });
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
          return Response.json([{
            id: "ws-1",
            name: "Build workspace",
            directory: "/workspace/repo",
          }]);
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

  test("uploads binary chunks to an absolute remote destination", async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), "clanky-workspace-upload-"));
    try {
      const sourcePath = join(sourceDirectory, "artifact.bin");
      const sourceBytes = Uint8Array.from(
        { length: 8 * 1024 * 1024 + 7 },
        (_, index) => index % 256,
      );
      await writeFile(sourcePath, sourceBytes);

      const requests: Array<{ url: URL; init: RequestInit }> = [];
      const uploadedChunks: Uint8Array[] = [];
      const chunkAttempts = new Map<number, number>();
      const fetchFn = createFetch(async (url, init) => {
        requests.push({ url, init });
        if (url.pathname === "/api/workspaces") {
          return Response.json([{
            id: "ws-1",
            name: "Build workspace",
            directory: "/workspace/repo",
          }]);
        }
        if (url.pathname.endsWith("/files/upload")) {
          expect(JSON.parse(String(init.body))).toEqual({
            directory: "",
            fileName: "artifact.bin",
            size: sourceBytes.byteLength,
            overwrite: true,
            startDirectory: "/tmp/uploads",
          });
          return Response.json({ uploadId: "upload-1" }, { status: 201 });
        }
        if (url.pathname.endsWith("/files/upload/chunk")) {
          const offset = Number(url.searchParams.get("offset"));
          const attempt = (chunkAttempts.get(offset) ?? 0) + 1;
          chunkAttempts.set(offset, attempt);
          if (offset === 0 && attempt === 1) {
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
          expect(JSON.parse(String(init.body))).toEqual({
            uploadId: "upload-1",
            startDirectory: "/tmp/uploads",
          });
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
      expect(uploadedChunks).toHaveLength(2);
      expect(chunkAttempts.get(0)).toBe(2);
      expect(chunkAttempts.get(8 * 1024 * 1024)).toBe(1);
      expect(requests[1]?.url.pathname).toBe("/api/workspaces/ws-1/files/upload");
      expect(requests[2]?.url.searchParams.get("startDirectory")).toBe("/tmp/uploads");
      expect(stdoutChunks).toEqual([`Uploaded ${sourcePath} to /tmp/uploads/artifact.bin\n`]);
      expect(stderrChunks).toEqual([]);
    } finally {
      await rm(sourceDirectory, { recursive: true, force: true });
    }
  });

  test("uses the workspace directory and local basename by default", async () => {
    const sourceDirectory = await mkdtemp(join(tmpdir(), "clanky-workspace-upload-default-"));
    try {
      const sourcePath = join(sourceDirectory, "notes.txt");
      await writeFile(sourcePath, "notes\n");
      let createBody: Record<string, unknown> | undefined;
      const fetchFn = createFetch((url, init) => {
        if (url.pathname === "/api/workspaces") {
          return Response.json([{
            id: "ws-1",
            name: "Build workspace",
            directory: "/workspace/repo",
          }]);
        }
        if (url.pathname.endsWith("/files/upload")) {
          createBody = JSON.parse(String(init.body)) as Record<string, unknown>;
          return Response.json({ uploadId: "upload-2" }, { status: 201 });
        }
        if (url.pathname.endsWith("/files/upload/chunk")) {
          return Response.json({
            success: true,
            uploadId: "upload-2",
            bytesWritten: 6,
            nextOffset: 6,
          });
        }
        return Response.json({
          success: true,
          file: { path: "notes.txt" },
          overwritten: false,
        });
      });
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      const result = await runWorkspaceCommand(createWorkspaceContext(
        ["upload", "ws-1", sourcePath],
        fetchFn,
        stdoutChunks,
        stderrChunks,
      ));

      expect(result).toEqual({ exitCode: 0 });
      expect(createBody).toEqual({
        directory: "",
        fileName: "notes.txt",
        size: 6,
        overwrite: false,
        startDirectory: "/workspace/repo",
      });
      expect(stdoutChunks).toEqual([`Uploaded ${sourcePath} to /workspace/repo/notes.txt\n`]);
      expect(stderrChunks).toEqual([]);
    } finally {
      await rm(sourceDirectory, { recursive: true, force: true });
    }
  });
});
