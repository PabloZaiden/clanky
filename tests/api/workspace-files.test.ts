import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { ensureDataDirectories, getDatabase } from "../../src/persistence/database";
import { apiRoutes } from "../../src/api";
import { backendManager } from "../../src/core/backend-manager";
import { createMockBackend } from "../mocks/mock-backend";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { serve, type Server } from "bun";
import { join } from "path";
import { mkdtemp, rm, mkdir, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";

describe("workspace files API integration", () => {
  let dataDir: string;
  let workDir: string;
  let alternateRootDir: string;
  let server: Server<unknown>;
  let baseUrl: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "ralpher-workspace-files-data-"));
    workDir = await mkdtemp(join(tmpdir(), "ralpher-workspace-files-work-"));
    alternateRootDir = await mkdtemp(join(tmpdir(), "ralpher-workspace-files-alt-"));
    process.env["RALPHER_DATA_DIR"] = dataDir;

    await ensureDataDirectories();
    await Bun.$`git init ${workDir}`.quiet();
    await Bun.$`git -C ${workDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${workDir} config user.name "Test User"`.quiet();
    await mkdir(join(workDir, "src"), { recursive: true });
    await writeFile(join(workDir, "README.md"), "# Workspace files\n");
    await writeFile(join(workDir, "src", "index.ts"), "export const value = 1;\n");
    await Bun.$`git -C ${workDir} add .`.quiet();
    await Bun.$`git -C ${workDir} commit -m "Initial commit"`.quiet();
    await mkdir(join(alternateRootDir, "notes"), { recursive: true });
    await writeFile(join(alternateRootDir, "notes", "todo.txt"), "alternate root note\n");

    backendManager.setBackendForTesting(createMockBackend());
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    server = serve({
      port: 0,
      routes: {
        ...apiRoutes,
      },
    });
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    server.stop();
    backendManager.resetForTesting();
    await rm(dataDir, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
    await rm(alternateRootDir, { recursive: true, force: true });
    delete process.env["RALPHER_DATA_DIR"];
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

  test("lists root directory entries as lightweight explorer nodes", async () => {
    const workspace = await createWorkspace();

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files`);
    expect(response.ok).toBe(true);

    const data = await response.json() as {
      directory: string;
      entries: Array<{ name: string; path: string; kind: string; versionToken?: string }>;
    };
    expect(data.directory).toBe("");
    expect(data.entries.map((entry) => entry.name)).toEqual([".git", "src", "README.md"]);
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
    expect(data.entries.map((entry) => entry.name)).toEqual([".git", "src", "README.md"]);
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

  test("loads the full file tree from the selected root", async () => {
    const workspace = await createWorkspace();

    const response = await fetch(`${baseUrl}/api/workspaces/${workspace.id}/files/tree`);
    expect(response.ok).toBe(true);

    const data = await response.json() as {
      entriesByDirectory: Record<string, Array<{ name: string; path: string; kind: string }>>;
    };
    expect(data.entriesByDirectory[""]?.map((entry) => entry.name)).toEqual([".git", "src", "README.md"]);
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
      expect(data.entriesByDirectory[""]?.map((entry) => entry.name)).toEqual([".git", "src", "src-link", "readme-link", "README.md"]);
      expect(data.entriesByDirectory[""]?.map((entry) => entry.kind)).toEqual(["directory", "directory", "directory", "file", "file"]);
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
      expect(data.entriesByDirectory[""]?.map((entry) => entry.name)).toEqual([".git", "src", "broken-link", "README.md"]);
      expect(data.entriesByDirectory[""]?.map((entry) => entry.kind)).toEqual(["directory", "directory", "file", "file"]);
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
});
