import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ensureDataDirectories, getDatabase } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import type { CommandOptions, CommandResult, FileStreamOptions } from "../../src/core/command-executor";
import { CommandExecutorImpl } from "../../src/core/remote-command-executor";
import { createMockBackend } from "../mocks/mock-backend";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { type Server } from "bun";
import { serveNativeApiRoutes } from "../native-api-server";
import { join } from "path";
import { mkdtemp, rm, mkdir, readFile, stat, symlink, utimes, writeFile } from "fs/promises";
import { tmpdir } from "os";

describe("workspace files API integration", () => {
  const previousDownloadLimitBytes = 100 * 1024 * 1024;
  let dataDir: string;
  let workDir: string;
  let alternateRootDir: string;
  let server: Server<unknown>;
  let baseUrl: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-workspace-files-data-"));
    workDir = await mkdtemp(join(tmpdir(), "clanky-workspace-files-work-"));
    alternateRootDir = await mkdtemp(join(tmpdir(), "clanky-workspace-files-alt-"));
    process.env["CLANKY_DATA_DIR"] = dataDir;

    await ensureDataDirectories();
    await Bun.$`git init ${workDir}`.quiet();
    await Bun.$`git -C ${workDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${workDir} config user.name "Test User"`.quiet();
    await mkdir(join(workDir, "src"), { recursive: true });
    await mkdir(join(workDir, "assets.png"), { recursive: true });
    await writeFile(join(workDir, "README.md"), "# Workspace files\n");
    await writeFile(join(workDir, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(join(workDir, "logo.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"></svg>\n");
    await Bun.$`git -C ${workDir} add .`.quiet();
    await Bun.$`git -C ${workDir} commit -m "Initial commit"`.quiet();
    await mkdir(join(alternateRootDir, "notes"), { recursive: true });
    await writeFile(join(alternateRootDir, "notes", "todo.txt"), "alternate root note\n");

    backendManager.setBackendForTesting(createMockBackend());
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    server.stop();
    backendManager.resetForTesting();
    await rm(dataDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
    await rm(alternateRootDir, { recursive: true, force: true });
    delete process.env["CLANKY_DATA_DIR"];
  });

  beforeEach(() => {
    const db = getDatabase();
    db.run("DELETE FROM workspaces");
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());
  });

  async function createWorkspace() {
    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Workspace Files",
        directory: workDir,
        serverSettings: {
          agent: {
            provider: "opencode",
            transport: "stdio",
          },
        },
      }),
    });
    expect(response.ok).toBe(true);
    return await response.json() as { id: string };
  }

  class LargeDownloadExecutor extends TestCommandExecutor {
    bytesCommandCalled = false;
    streamClosed = false;

    private readonly largeDownloadPayloadPrefix = new TextEncoder().encode("large download payload\n");
    private readonly largeDownloadSize = previousDownloadLimitBytes + 1;

    override async exec(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
      const commandLabel = args[2];
      const requestedPath = args[3];
      if (command === "bash" && commandLabel === "file-explorer-metadata" && requestedPath?.endsWith("/large-download.bin")) {
        return {
          success: true,
          stdout: `f\t${this.largeDownloadSize}\t1700000000\tlarge-download-hash\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      if (command === "bash" && commandLabel === "file-explorer-file-bytes" && requestedPath?.endsWith("/large-download.bin")) {
        this.bytesCommandCalled = true;
        return {
          success: false,
          stdout: Buffer.from("large download payload\n").toString("base64"),
          stderr: "download should use streamFile instead of file-explorer-file-bytes",
          exitCode: 1,
        };
      }
      return await super.exec(command, args, options);
    }

    override async streamFile(path: string, _options?: FileStreamOptions): Promise<ReadableStream<Uint8Array> | null> {
      if (!path.endsWith("/large-download.bin")) {
        return await super.streamFile(path, _options);
      }

      let remainingBytes = this.largeDownloadSize;
      let prefixSent = false;

      return new ReadableStream<Uint8Array>({
        pull: (controller) => {
          if (!prefixSent) {
            controller.enqueue(this.largeDownloadPayloadPrefix);
            remainingBytes -= this.largeDownloadPayloadPrefix.byteLength;
            prefixSent = true;
            return;
          }

          if (remainingBytes <= 0) {
            controller.close();
            return;
          }

          const chunkSize = Math.min(remainingBytes, 64 * 1024);
          controller.enqueue(new Uint8Array(chunkSize));
          remainingBytes -= chunkSize;
        },
        cancel: () => {
          this.streamClosed = true;
        },
      });
    }
  }

  class DownloadMetadataWithoutHashExecutor extends TestCommandExecutor {
    hashRequested = false;
    streamRequested = false;

    private readonly payload = new TextEncoder().encode("download without hashing\n");

    get payloadByteLength(): number {
      return this.payload.byteLength;
    }

    override async exec(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
      const commandLabel = args[2];
      const requestedPath = args[3];
      const includeHash = args[4];
      if (
        command === "bash"
        && commandLabel === "file-explorer-metadata"
        && requestedPath?.endsWith("/slow-hash-download.bin")
      ) {
        if (includeHash !== "0") {
          this.hashRequested = true;
          return {
            success: false,
            stdout: "",
            stderr: "download metadata should not request a content hash",
            exitCode: 124,
          };
        }
        return {
          success: true,
          stdout: `f\t${this.payload.byteLength}\t1700000000\t-\n`,
          stderr: "",
          exitCode: 0,
        };
      }
      return await super.exec(command, args, options);
    }

    override async streamFile(path: string, _options?: FileStreamOptions): Promise<ReadableStream<Uint8Array> | null> {
      if (!path.endsWith("/slow-hash-download.bin")) {
        return await super.streamFile(path, _options);
      }

      this.streamRequested = true;
      const payload = this.payload;
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(payload);
          controller.close();
        },
      });
    }
  }

  class UploadTrackingExecutor extends TestCommandExecutor {
    writeFileCalled = false;
    streamWriteCalls = 0;

    override async writeFile(path: string, content: string): Promise<boolean> {
      this.writeFileCalled = true;
      return await super.writeFile(path, content);
    }

    override async writeFileStream(
      path: string,
      stream: ReadableStream<Uint8Array>,
      options?: Parameters<TestCommandExecutor["writeFileStream"]>[2],
    ) {
      this.streamWriteCalls += 1;
      return await super.writeFileStream(path, stream, options);
    }
  }

  test("lists root directory entries as lightweight explorer nodes", async () => {
    const workspace = await createWorkspace();

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files`);
    expect(response.ok).toBe(true);

    const data = await response.json() as {
      directory: string;
      entries: Array<{ name: string; path: string; kind: string; versionToken?: string }>;
    };
    expect(data.directory).toBe("");
    expect(data.entries.map((entry) => entry.name)).toEqual([".git", "assets.png", "src", "logo.svg", "README.md"]);
    expect(data.entries.find((entry) => entry.name === ".git")?.kind).toBe("directory");
    expect(data.entries.find((entry) => entry.name === "README.md")?.path).toBe("README.md");
    expect(data.entries[0]?.versionToken).toBeUndefined();
  });

  test("ignores showHidden query params and always returns lightweight directory entries", async () => {
    const workspace = await createWorkspace();

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files?showHidden=false`);
    expect(response.ok).toBe(true);

    const data = await response.json() as {
      directory: string;
      entries: Array<{ name: string; kind: string }>;
    };
    expect(data.directory).toBe("");
    expect(data.entries.map((entry) => entry.name)).toEqual([".git", "assets.png", "src", "logo.svg", "README.md"]);
    expect(data.entries.find((entry) => entry.name === ".git")?.kind).toBe("directory");
  });

  test("reads file content and metadata", async () => {
    const workspace = await createWorkspace();

    const response = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/files/content?path=${encodeURIComponent("src/index.ts")}`,
    );
    expect(response.ok).toBe(true);

    const data = await response.json() as {
      content: string;
      file: { path: string; absolutePath: string; kind: string };
    };
    expect(data.content).toContain("value = 1");
    expect(data.file.path).toBe("src/index.ts");
    expect(data.file.absolutePath).toBe(join(workDir, "src", "index.ts"));
    expect(data.file.kind).toBe("file");
  });

  test("previews browser-renderable image files with image content type", async () => {
    const workspace = await createWorkspace();

    const response = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/files/preview?path=${encodeURIComponent("logo.svg")}`,
    );
    expect(response.ok).toBe(true);
    expect(response.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.text()).toContain("<svg");

    const metadataResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/files/metadata?path=${encodeURIComponent("logo.svg")}`,
    );
    const metadata = await metadataResponse.json() as { file: { isImage?: boolean; mimeType?: string } };
    expect(metadata.file.isImage).toBe(true);
    expect(metadata.file.mimeType).toBe("image/svg+xml");
  });

  test("downloads workspace files as attachments", async () => {
    const workspace = await createWorkspace();
    const rfc5987FileName = "rfc5987-!'()*.txt";

    const metadataResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/files/metadata?path=${encodeURIComponent("README.md")}`,
    );
    expect(metadataResponse.ok).toBe(true);
    const metadata = await metadataResponse.json() as {
      file: { name: string; path: string; kind: string; size: number };
    };
    expect(metadata.file).toMatchObject({
      name: "README.md",
      path: "README.md",
      kind: "file",
      size: "# Workspace files\n".length,
    });

    const downloadUrl = `${baseUrl}/api/workspaces/${workspace.id}/files/download?path=${encodeURIComponent("README.md")}`;
    const headResponse = await fetch(downloadUrl, { method: "HEAD" });
    expect(headResponse.ok).toBe(true);
    expect(headResponse.headers.get("Content-Disposition")).toContain("attachment; filename=\"README.md\"");
    expect(headResponse.headers.get("Content-Length")).toBe(String(metadata.file.size));
    expect(headResponse.headers.get("X-Clanky-Download-Size")).toBe(String(metadata.file.size));

    const response = await fetch(downloadUrl);

    expect(response.ok).toBe(true);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Disposition")).toContain("attachment; filename=\"README.md\"");
    expect(response.headers.get("Content-Length")).toBe(String(metadata.file.size));
    expect(response.headers.get("X-Clanky-Download-Size")).toBe(String(metadata.file.size));
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("Content-Length");
    expect(response.headers.get("Access-Control-Expose-Headers")).toContain("X-Clanky-Download-Size");
    expect(await response.text()).toBe("# Workspace files\n");

    const binaryFileName = "binary.dat";
    const binaryPayload = Uint8Array.from({ length: 256 }, (_, index) => index);
    await writeFile(join(workDir, binaryFileName), binaryPayload);
    try {
      const binaryResponse = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/files/download?path=${encodeURIComponent(binaryFileName)}`,
      );
      expect(binaryResponse.ok).toBe(true);
      expect(new Uint8Array(await binaryResponse.arrayBuffer())).toEqual(binaryPayload);
    } finally {
      await rm(join(workDir, binaryFileName), { force: true });
    }

    await writeFile(join(workDir, rfc5987FileName), "special name\n");
    try {
      const specialResponse = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/files/download?path=${encodeURIComponent(rfc5987FileName)}`,
      );

      expect(specialResponse.ok).toBe(true);
      expect(specialResponse.headers.get("Content-Disposition")).toBe(
        "attachment; filename=\"rfc5987-!'()*.txt\"; filename*=UTF-8''rfc5987-%21%27%28%29%2A.txt",
      );
      expect(await specialResponse.text()).toBe("special name\n");
    } finally {
      await rm(join(workDir, rfc5987FileName), { force: true });
    }
  });

  test("starts streaming files larger than the previous file explorer download limit without base64 buffering", async () => {
    const largeDownloadExecutor = new LargeDownloadExecutor();
    backendManager.setExecutorFactoryForTesting(() => largeDownloadExecutor);
    const workspace = await createWorkspace();

    const downloadUrl =
      `${baseUrl}/api/workspaces/${workspace.id}/files/download?path=${encodeURIComponent("large-download.bin")}`;
    const headResponse = await fetch(downloadUrl, { method: "HEAD" });
    expect(headResponse.ok).toBe(true);
    expect(headResponse.headers.get("Content-Disposition")).toContain("attachment; filename=\"large-download.bin\"");
    expect(headResponse.headers.get("Content-Length")).toBe(String(previousDownloadLimitBytes + 1));
    expect(headResponse.headers.get("X-Clanky-Download-Size")).toBe(String(previousDownloadLimitBytes + 1));

    const response = await fetch(downloadUrl);

    expect(response.ok).toBe(true);
    expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Disposition")).toContain("attachment; filename=\"large-download.bin\"");
    expect(response.headers.get("X-Clanky-Download-Size")).toBe(String(previousDownloadLimitBytes + 1));
    expect(largeDownloadExecutor.bytesCommandCalled).toBe(false);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const firstChunk = await reader!.read();
    expect(firstChunk.done).toBe(false);
    expect(new TextDecoder().decode(firstChunk.value).startsWith("large download payload")).toBe(true);
    await reader!.cancel();
  });

  test("starts download responses without hashing the whole file first", async () => {
    const downloadExecutor = new DownloadMetadataWithoutHashExecutor();
    backendManager.setExecutorFactoryForTesting(() => downloadExecutor);
    const workspace = await createWorkspace();
    const downloadUrl =
      `${baseUrl}/api/workspaces/${workspace.id}/files/download?path=${encodeURIComponent("slow-hash-download.bin")}`;

    const headResponse = await fetch(downloadUrl, { method: "HEAD" });
    expect(headResponse.ok).toBe(true);
    expect(headResponse.headers.get("Content-Length")).toBe(String(downloadExecutor.payloadByteLength));
    expect(downloadExecutor.hashRequested).toBe(false);

    const response = await fetch(downloadUrl);

    expect(response.ok).toBe(true);
    expect(await response.text()).toBe("download without hashing\n");
    expect(downloadExecutor.hashRequested).toBe(false);
    expect(downloadExecutor.streamRequested).toBe(true);
  });

  test("does not report directories with image-like names as images", async () => {
    const workspace = await createWorkspace();

    const response = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/files/metadata?path=${encodeURIComponent("assets.png")}`,
    );
    expect(response.ok).toBe(true);

    const data = await response.json() as {
      file: { path: string; kind: string; isImage?: boolean; mimeType?: string };
    };
    expect(data.file.path).toBe("assets.png");
    expect(data.file.kind).toBe("directory");
    expect(data.file.isImage).toBeUndefined();
    expect(data.file.mimeType).toBeUndefined();
  });

  test("loads the full file tree from the selected root", async () => {
    const workspace = await createWorkspace();

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/tree`);
    expect(response.ok).toBe(true);

    const data = await response.json() as {
      entriesByDirectory: Record<string, Array<{ name: string; path: string; kind: string }>>;
    };
    expect(data.entriesByDirectory[""]?.map((entry) => entry.name)).toEqual([".git", "assets.png", "src", "logo.svg", "README.md"]);
    expect(data.entriesByDirectory["src"]?.map((entry) => entry.path)).toEqual(["src/index.ts"]);
  });

  test("keeps symlinked directories as directory entries without traversing into them", async () => {
    const workspace = await createWorkspace();
    const directoryLinkPath = join(workDir, "src-link");
    const fileLinkPath = join(workDir, "readme-link");
    await symlink(join(workDir, "src"), directoryLinkPath);
    await symlink(join(workDir, "README.md"), fileLinkPath);

    try {
      const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/tree`);
      expect(response.ok).toBe(true);

      const data = await response.json() as {
        entriesByDirectory: Record<string, Array<{ name: string; path: string; kind: string }>>;
      };
      expect(data.entriesByDirectory[""]?.map((entry) => entry.name)).toEqual([".git", "assets.png", "src", "src-link", "logo.svg", "readme-link", "README.md"]);
      expect(data.entriesByDirectory[""]?.map((entry) => entry.kind)).toEqual(["directory", "directory", "directory", "directory", "file", "file", "file"]);
      expect(data.entriesByDirectory["src-link"]).toEqual([]);
    } finally {
      await rm(directoryLinkPath, { force: true });
      await rm(fileLinkPath, { force: true });
    }
  });

  test("keeps broken symlinks as file entries without failing tree loading", async () => {
    const workspace = await createWorkspace();
    const brokenLinkPath = join(workDir, "broken-link");
    await symlink(join(workDir, "missing-target"), brokenLinkPath);

    try {
      const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/tree`);
      expect(response.ok).toBe(true);

      const data = await response.json() as {
        entriesByDirectory: Record<string, Array<{ name: string; path: string; kind: string }>>;
      };
      expect(data.entriesByDirectory[""]?.map((entry) => entry.name)).toEqual([".git", "assets.png", "src", "broken-link", "logo.svg", "README.md"]);
      expect(data.entriesByDirectory[""]?.map((entry) => entry.kind)).toEqual(["directory", "directory", "directory", "file", "file", "file"]);
    } finally {
      await rm(brokenLinkPath, { force: true });
    }
  });

  test("loads the full file tree from an alternate root", async () => {
    const workspace = await createWorkspace();
    const startDirectory = encodeURIComponent(alternateRootDir);

    const response = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/files/tree?startDirectory=${startDirectory}`,
    );
    expect(response.ok).toBe(true);

    const data = await response.json() as {
      entriesByDirectory: Record<string, Array<{ name: string; path: string }>>;
    };
    expect(data.entriesByDirectory[""]?.map((entry) => entry.name)).toEqual(["notes"]);
    expect(data.entriesByDirectory["notes"]?.map((entry) => entry.path)).toEqual(["notes/todo.txt"]);
  });

  test("returns metadata for a single file", async () => {
    const workspace = await createWorkspace();

    const response = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/files/metadata?path=${encodeURIComponent("src/index.ts")}`,
    );
    expect(response.ok).toBe(true);

    const data = await response.json() as { file: { path: string; absolutePath: string; versionToken: string } };
    expect(data.file.path).toBe("src/index.ts");
    expect(data.file.absolutePath).toBe(join(workDir, "src", "index.ts"));
    expect(data.file.versionToken.length).toBeGreaterThan(0);
  });

  test("writes a file when the version token still matches", async () => {
    const workspace = await createWorkspace();
    const metadataResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/files/metadata?path=${encodeURIComponent("src/index.ts")}`,
    );
    const metadata = await metadataResponse.json() as { file: { versionToken: string } };

    const writeResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "src/index.ts",
        content: "export const value = 2;\n",
        expectedVersionToken: metadata.file.versionToken,
        overwrite: false,
        startDirectory: null,
      }),
    });

    expect(writeResponse.ok).toBe(true);
    const writeData = await writeResponse.json() as { file: { versionToken: string } };
    expect(writeData.file.versionToken).not.toBe(metadata.file.versionToken);

    const contentResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/files/content?path=${encodeURIComponent("src/index.ts")}`,
    );
    const contentData = await contentResponse.json() as { content: string };
    expect(contentData.content).toContain("value = 2");
  });

  test("returns a conflict when the file changed outside the editor", async () => {
    const workspace = await createWorkspace();
    const metadataResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/files/metadata?path=${encodeURIComponent("src/index.ts")}`,
    );
    const metadata = await metadataResponse.json() as { file: { versionToken: string } };

    await Bun.write(join(workDir, "src", "index.ts"), "export const value = 7;\n");

    const writeResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "src/index.ts",
        content: "export const value = 3;\n",
        expectedVersionToken: metadata.file.versionToken,
        overwrite: false,
        startDirectory: null,
      }),
    });

    expect(writeResponse.status).toBe(409);
    const data = await writeResponse.json() as {
      error: string;
      currentFile: { path: string } | null;
    };
    expect(data.error).toBe("file_conflict");
    expect(data.currentFile?.path).toBe("src/index.ts");
  });

    test("renames and deletes workspace files and directories", async () => {
      const workspace = await createWorkspace();
      await mkdir(join(workDir, "rename-dir", "child"), { recursive: true });
      await writeFile(join(workDir, "rename-dir", "child", "note.txt"), "nested note\n");

      const fileRenameResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "README.md",
          newName: "README-renamed.md",
          expectedVersionToken: null,
        }),
      });
      expect(fileRenameResponse.ok).toBe(true);
      const fileRenameData = await fileRenameResponse.json() as { previousPath: string; file: { path: string } };
      expect(fileRenameData.previousPath).toBe("README.md");
      expect(fileRenameData.file.path).toBe("README-renamed.md");
      expect(await Bun.file(join(workDir, "README-renamed.md")).text()).toBe("# Workspace files\n");

      const directoryRenameResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "rename-dir",
          newName: "renamed-dir",
        }),
      });
      expect(directoryRenameResponse.ok).toBe(true);
      expect(await Bun.file(join(workDir, "renamed-dir", "child", "note.txt")).text()).toBe("nested note\n");

      const deleteFileResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "README-renamed.md",
          kind: "file",
        }),
      });
      expect(deleteFileResponse.ok).toBe(true);
      expect(await Bun.file(join(workDir, "README-renamed.md")).exists()).toBe(false);

      const deleteDirectoryResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "renamed-dir",
          kind: "directory",
        }),
      });
      expect(deleteDirectoryResponse.ok).toBe(true);
      expect(await Bun.file(join(workDir, "renamed-dir", "child", "note.txt")).exists()).toBe(false);
    });

    test("rejects unsafe workspace rename and delete requests", async () => {
      const workspace = await createWorkspace();

      const pathTraversalRenameResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "src/index.ts",
          newName: "../escape.ts",
        }),
      });
      expect(pathTraversalRenameResponse.status).toBe(400);
      expect(await pathTraversalRenameResponse.json()).toMatchObject({
        error: "invalid_file_name",
      });

      const rootDeleteResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/delete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: ".",
          kind: "directory",
        }),
      });
      expect(rootDeleteResponse.status).toBe(400);
      expect(await rootDeleteResponse.json()).toMatchObject({
        error: "invalid_workspace_path",
      });
    });

    test("uploads workspace files in chunks using streamed writes", async () => {
      const uploadExecutor = new UploadTrackingExecutor();
      backendManager.setExecutorFactoryForTesting(() => uploadExecutor);
      const workspace = await createWorkspace();

      const createResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directory: "src",
          fileName: "uploaded.txt",
          size: 11,
          overwrite: false,
        }),
      });
      expect(createResponse.status).toBe(201);
      const session = await createResponse.json() as { uploadId: string };

      const firstChunkResponse = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/files/upload/chunk?uploadId=${encodeURIComponent(session.uploadId)}&offset=0`,
        {
          method: "POST",
          body: new Blob(["hello "]),
        },
      );
      expect(firstChunkResponse.ok).toBe(true);
      expect(await firstChunkResponse.json()).toMatchObject({ nextOffset: 6 });

      const secondChunkResponse = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/files/upload/chunk?uploadId=${encodeURIComponent(session.uploadId)}&offset=6`,
        {
          method: "POST",
          body: new Blob(["world"]),
        },
      );
      expect(secondChunkResponse.ok).toBe(true);
      expect(await secondChunkResponse.json()).toMatchObject({ nextOffset: 11 });

      const completeResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/upload/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId: session.uploadId }),
      });
      expect(completeResponse.ok).toBe(true);
      const completeData = await completeResponse.json() as { file: { path: string; size: number } };
      expect(completeData.file).toMatchObject({ path: "src/uploaded.txt", size: 11 });
      expect(await Bun.file(join(workDir, "src", "uploaded.txt")).text()).toBe("hello world");
      expect(await Bun.file(join(workDir, ".clanky-upload-tmp")).exists()).toBe(false);
      expect(uploadExecutor.writeFileCalled).toBe(false);
      expect(uploadExecutor.streamWriteCalls).toBe(2);
    });

    test("rejects overwrite requests when destination kinds are incompatible", async () => {
      const workspace = await createWorkspace();
      await writeFile(join(workDir, "rename-kind-source.txt"), "source\n");
      await mkdir(join(workDir, "rename-kind-target"), { recursive: true });
      await mkdir(join(workDir, "rename-kind-dir-source"), { recursive: true });
      await writeFile(join(workDir, "rename-kind-file-target.txt"), "target\n");

      const renameFileIntoDirectoryResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "rename-kind-source.txt",
          newName: "rename-kind-target",
          overwrite: true,
        }),
      });
      expect(renameFileIntoDirectoryResponse.status).toBe(409);
      expect(await Bun.file(join(workDir, "rename-kind-source.txt")).text()).toBe("source\n");
      expect((await stat(join(workDir, "rename-kind-target"))).isDirectory()).toBe(true);

      const renameDirectoryIntoFileResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: "rename-kind-dir-source",
          newName: "rename-kind-file-target.txt",
          overwrite: true,
        }),
      });
      expect(renameDirectoryIntoFileResponse.status).toBe(409);
      expect((await stat(join(workDir, "rename-kind-dir-source"))).isDirectory()).toBe(true);
      expect(await Bun.file(join(workDir, "rename-kind-file-target.txt")).text()).toBe("target\n");

      const createOverDirectoryResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directory: ".",
          fileName: "rename-kind-target",
          size: 4,
          overwrite: true,
        }),
      });
      expect(createOverDirectoryResponse.status).toBe(409);

      await writeFile(join(workDir, "late-upload-kind-change.txt"), "old\n");
      const createResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directory: ".",
          fileName: "late-upload-kind-change.txt",
          size: 3,
          overwrite: true,
        }),
      });
      expect(createResponse.status).toBe(201);
      const session = await createResponse.json() as { uploadId: string };

      const chunkResponse = await fetch(
        `${baseUrl}/api/workspaces/${workspace.id}/files/upload/chunk?uploadId=${encodeURIComponent(session.uploadId)}&offset=0`,
        {
          method: "POST",
          body: new Blob(["new"]),
        },
      );
      expect(chunkResponse.ok).toBe(true);

      await rm(join(workDir, "late-upload-kind-change.txt"), { force: true });
      await mkdir(join(workDir, "late-upload-kind-change.txt"), { recursive: true });
      const completeResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/upload/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId: session.uploadId }),
      });
      expect(completeResponse.status).toBe(409);
      expect((await stat(join(workDir, "late-upload-kind-change.txt"))).isDirectory()).toBe(true);
    });

    test("cleans abandoned upload temp files when creating a new session", async () => {
      const workspace = await createWorkspace();
      const abandonedDirectory = join(workDir, ".clanky-upload-tmp");
      const abandonedFile = join(abandonedDirectory, "abandoned-upload.tmp");
      await mkdir(abandonedDirectory, { recursive: true });
      await writeFile(abandonedFile, "abandoned\n");
      const oldTimestamp = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await utimes(abandonedFile, oldTimestamp, oldTimestamp);

      const createResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directory: "src",
          fileName: "cleanup-trigger.txt",
          size: 0,
          overwrite: false,
        }),
      });
      expect(createResponse.status).toBe(201);
      expect(await Bun.file(abandonedFile).exists()).toBe(false);
      expect(await Bun.file(abandonedDirectory).exists()).toBe(false);

      const session = await createResponse.json() as { uploadId: string };
      const cancelResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/upload/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId: session.uploadId }),
      });
      expect(cancelResponse.ok).toBe(true);
    });

    test("stream upload writers truncate oversized partial files before retrying chunks", async () => {
      const mockRetryPath = join(workDir, "mock-retry-upload.bin");
      await writeFile(mockRetryPath, "abcdef");
      const mockExecutor = new TestCommandExecutor();
      const mockRetryResult = await mockExecutor.writeFileStream(
        mockRetryPath,
        new Blob(["XYZ"]).stream(),
        { append: true, expectedOffset: 3 },
      );
      expect(mockRetryResult).toMatchObject({ success: true, bytesWritten: 3 });
      expect(await readFile(mockRetryPath, "utf8")).toBe("abcXYZ");

      const localRetryPath = join(workDir, "local-retry-upload.bin");
      await writeFile(localRetryPath, "123456");
      const localExecutor = new CommandExecutorImpl({ provider: "local", directory: workDir });
      const localRetryResult = await localExecutor.writeFileStream(
        localRetryPath,
        new Blob(["789"]).stream(),
        { append: true, expectedOffset: 3 },
      );
      expect(localRetryResult).toMatchObject({ success: true, bytesWritten: 3 });
      expect(await readFile(localRetryPath, "utf8")).toBe("123789");
    });

  test("requires an explicit overwrite to save an existing file without a version token", async () => {
    const workspace = await createWorkspace();

    const writeResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "src/index.ts",
        content: "export const value = 9;\n",
        expectedVersionToken: null,
        overwrite: false,
        startDirectory: null,
      }),
    });

    expect(writeResponse.status).toBe(409);
    const data = await writeResponse.json() as {
      error: string;
      message: string;
      currentFile: { path: string } | null;
    };
    expect(data.error).toBe("file_conflict");
    expect(data.message).toBe("File changed outside the code explorer");
    expect(data.currentFile?.path).toBe("src/index.ts");
  });

  test("rejects paths that escape the workspace root", async () => {
    const workspace = await createWorkspace();

    const response = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/files/content?path=${encodeURIComponent("../outside.txt")}`,
    );

    expect(response.status).toBe(400);
    const data = await response.json() as { error: string };
    expect(data.error).toBe("invalid_workspace_path");
  });

  test("can use an alternate absolute start directory for workspace operations", async () => {
    const workspace = await createWorkspace();
    const startDirectory = encodeURIComponent(alternateRootDir);

    const listResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/files?startDirectory=${startDirectory}`,
    );
    expect(listResponse.ok).toBe(true);
    const listData = await listResponse.json() as {
      directory: string;
      entries: Array<{ name: string; path: string }>;
    };
    expect(listData.directory).toBe("");
    expect(listData.entries.map((entry) => entry.name)).toEqual(["notes"]);

    const readResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/files/content?path=${encodeURIComponent("notes/todo.txt")}&startDirectory=${startDirectory}`,
    );
    expect(readResponse.ok).toBe(true);
    const readData = await readResponse.json() as { content: string; file: { path: string; absolutePath: string } };
    expect(readData.file.path).toBe("notes/todo.txt");
    expect(readData.file.absolutePath).toBe(join(alternateRootDir, "notes", "todo.txt"));
    expect(readData.content).toBe("alternate root note\n");

    const metadataResponse = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/files/metadata?path=${encodeURIComponent("notes/todo.txt")}&startDirectory=${startDirectory}`,
    );
    const metadata = await metadataResponse.json() as { file: { versionToken: string } };

    const writeResponse = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/write`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "notes/todo.txt",
        content: "updated alternate root note\n",
        expectedVersionToken: metadata.file.versionToken,
        overwrite: false,
        startDirectory: alternateRootDir,
      }),
    });
    expect(writeResponse.ok).toBe(true);

    expect(await Bun.file(join(alternateRootDir, "notes", "todo.txt")).text()).toBe("updated alternate root note\n");
  });

  test("returns an explicit error when the workspace start directory does not exist", async () => {
    const workspace = await createWorkspace();
    const missingStartDirectory = encodeURIComponent(join(alternateRootDir, "missing-root"));

    const response = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/files?startDirectory=${missingStartDirectory}`,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: "start_directory_not_found",
    });
  });

  test("maps shared executor failures to a stable internal error response", async () => {
    const workspace = await createWorkspace();

    class MetadataFailureExecutor extends TestCommandExecutor {
      override async exec(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
        if (command === "bash" && args[2] === "file-explorer-metadata") {
          return {
            success: false,
            stdout: "",
            stderr: "sensitive command failure",
            exitCode: 1,
          };
        }
        return await super.exec(command, args, options);
      }
    }

    backendManager.setExecutorFactoryForTesting(() => new MetadataFailureExecutor());

    const response = await fetch(
      `${baseUrl}/api/workspaces/${workspace.id}/files/content?path=${encodeURIComponent("README.md")}`,
    );

    expect(response.status).toBe(500);
    const data = await response.json() as { error: string; message: string };
    expect(data.error).toBe("workspace_file_error");
    expect(data.message).toBe("File explorer operation failed");
    expect(data.message).not.toContain("sensitive command failure");
  });
});
