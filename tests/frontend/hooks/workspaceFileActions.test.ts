import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  WorkspaceFileConflictError,
  getWorkspaceFileMetadataApi,
  listWorkspaceFilesApi,
  readWorkspaceFileApi,
  writeWorkspaceFileApi,
} from "@/hooks";
import { createMockApi, MockApiError } from "../helpers/mock-api";

const api = createMockApi();

describe("workspace file action helpers", () => {
  beforeEach(() => {
    api.reset();
    api.install();
  });

  afterEach(() => {
    api.uninstall();
  });

  test("lists workspace files", async () => {
    api.get("/api/workspaces/:id/files", () => ({
      workspaceId: "workspace-1",
      directory: "",
      entries: [
        {
          name: "src",
          path: "src",
          kind: "directory",
          size: 0,
          modifiedAt: "2026-01-01T00:00:00.000Z",
          versionToken: "123:0",
        },
      ],
    }));

    const response = await listWorkspaceFilesApi("workspace-1");
    expect(response.entries).toHaveLength(1);
    expect(api.calls("/api/workspaces/:id/files", "GET")).toHaveLength(1);
  });

  test("reads file content", async () => {
    api.get("/api/workspaces/:id/files/content", () => ({
      workspaceId: "workspace-1",
      file: {
        name: "index.ts",
        path: "src/index.ts",
        kind: "file",
        size: 20,
        modifiedAt: "2026-01-01T00:00:00.000Z",
        versionToken: "123:20",
      },
      content: "export const value = 1;\n",
    }));

    const response = await readWorkspaceFileApi("workspace-1", "src/index.ts");
    expect(response.content).toContain("value = 1");
  });

  test("fetches workspace file metadata", async () => {
    api.get("/api/workspaces/:id/files/metadata", () => ({
      workspaceId: "workspace-1",
      file: {
        name: "index.ts",
        path: "src/index.ts",
        kind: "file",
        size: 20,
        modifiedAt: "2026-01-01T00:00:00.000Z",
        versionToken: "123:20",
      },
    }));

    const response = await getWorkspaceFileMetadataApi("workspace-1", "src/index.ts");
    expect(response.file.versionToken).toBe("123:20");
  });

  test("throws a typed conflict error on save conflict", async () => {
    api.post("/api/workspaces/:id/files/write", () => {
      throw new MockApiError(409, {
        error: "file_conflict",
        message: "File changed outside the editor",
        currentFile: {
          name: "index.ts",
          path: "src/index.ts",
          kind: "file",
          size: 30,
          modifiedAt: "2026-01-01T00:00:00.000Z",
          versionToken: "456:30",
        },
      });
    });

    await expect(writeWorkspaceFileApi("workspace-1", {
      path: "src/index.ts",
      content: "export const value = 2;\n",
      expectedVersionToken: "123:20",
    })).rejects.toBeInstanceOf(WorkspaceFileConflictError);
  });
});
