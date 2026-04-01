import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useWorkspaceFiles } from "@/hooks";
import { createMockApi, MockApiError } from "../helpers/mock-api";

const api = createMockApi();

function createDirectoryEntry(overrides?: Partial<{
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: string;
  versionToken: string;
}>) {
  return {
    name: overrides?.name ?? "src",
    path: overrides?.path ?? "src",
    kind: overrides?.kind ?? "directory",
    size: overrides?.size ?? 0,
    modifiedAt: overrides?.modifiedAt ?? "2026-01-01T00:00:00.000Z",
    versionToken: overrides?.versionToken ?? "100:0",
  };
}

describe("useWorkspaceFiles", () => {
  beforeEach(() => {
    api.reset();
    api.install();
  });

  afterEach(() => {
    api.uninstall();
  });

  test("loads the root tree on mount", async () => {
    api.get("/api/workspaces/:id/files", () => ({
      workspaceId: "workspace-1",
      directory: "",
      entries: [
        createDirectoryEntry(),
        createDirectoryEntry({
          name: "README.md",
          path: "README.md",
          kind: "file",
          size: 10,
          versionToken: "100:10",
        }),
      ],
    }));

    const { result } = renderHook(() => useWorkspaceFiles("workspace-1"));

    await waitFor(() => {
      expect(result.current.loadingTree).toBe(false);
    });

    expect(result.current.directoryEntries[""]?.map((entry) => entry.name)).toEqual(["src", "README.md"]);
  });

  test("toggles hidden files and refreshes expanded directories", async () => {
    api.get("/api/workspaces/:id/files", (req) => {
      const url = new URL(req.url, "http://localhost");
      const path = url.searchParams.get("path") ?? "";
      const showHidden = url.searchParams.get("showHidden") === "true";

      if (path === "src") {
        return {
          workspaceId: "workspace-1",
          directory: "src",
          entries: showHidden
            ? [
                createDirectoryEntry({
                  name: ".secret.ts",
                  path: "src/.secret.ts",
                  kind: "file",
                  size: 5,
                  versionToken: "101:5",
                }),
                createDirectoryEntry({
                  name: "index.ts",
                  path: "src/index.ts",
                  kind: "file",
                  size: 20,
                  versionToken: "100:20",
                }),
              ]
            : [createDirectoryEntry({
                name: "index.ts",
                path: "src/index.ts",
                kind: "file",
                size: 20,
                versionToken: "100:20",
              })],
        };
      }

      return {
        workspaceId: "workspace-1",
        directory: "",
        entries: showHidden
          ? [
              createDirectoryEntry(),
              createDirectoryEntry({
                name: ".env",
                path: ".env",
                kind: "file",
                size: 10,
                versionToken: "100:10",
              }),
            ]
          : [createDirectoryEntry()],
      };
    });

    const { result } = renderHook(() => useWorkspaceFiles("workspace-1"));

    await waitFor(() => {
      expect(result.current.loadingTree).toBe(false);
    });

    await act(async () => {
      await result.current.toggleDirectory("src");
    });

    expect(result.current.directoryEntries[""]?.map((entry) => entry.name)).toEqual(["src"]);
    expect(result.current.directoryEntries["src"]?.map((entry) => entry.name)).toEqual(["index.ts"]);
    expect(result.current.showHiddenFiles).toBe(false);

    await act(async () => {
      await result.current.toggleShowHiddenFiles();
    });

    expect(result.current.showHiddenFiles).toBe(true);
    expect(result.current.directoryEntries[""]?.map((entry) => entry.name)).toEqual(["src", ".env"]);
    expect(result.current.directoryEntries["src"]?.map((entry) => entry.name)).toEqual([".secret.ts", "index.ts"]);
  });

  test("opens a file, tracks dirty state, and saves successfully", async () => {
    api.get("/api/workspaces/:id/files", () => ({
      workspaceId: "workspace-1",
      directory: "",
      entries: [createDirectoryEntry({
        name: "index.ts",
        path: "src/index.ts",
        kind: "file",
        size: 20,
        versionToken: "100:20",
      })],
    }));
    api.get("/api/workspaces/:id/files/content", () => ({
      workspaceId: "workspace-1",
      file: createDirectoryEntry({
        name: "index.ts",
        path: "src/index.ts",
        kind: "file",
        size: 20,
        versionToken: "100:20",
      }),
      content: "export const value = 1;\n",
    }));
    api.post("/api/workspaces/:id/files/write", () => ({
      success: true,
      workspaceId: "workspace-1",
      overwritten: false,
      file: createDirectoryEntry({
        name: "index.ts",
        path: "src/index.ts",
        kind: "file",
        size: 20,
        versionToken: "200:20",
      }),
    }));

    const { result } = renderHook(() => useWorkspaceFiles("workspace-1"));
    await waitFor(() => {
      expect(result.current.loadingTree).toBe(false);
    });

    await act(async () => {
      await result.current.openFile("src/index.ts");
    });

    act(() => {
      result.current.setEditorContent("export const value = 2;\n");
    });

    expect(result.current.isDirty).toBe(true);

    await act(async () => {
      await result.current.saveCurrentFile();
    });

    expect(result.current.isDirty).toBe(false);
    expect(result.current.currentFile?.versionToken).toBe("200:20");
  });

  test("surfaces save conflicts", async () => {
    api.get("/api/workspaces/:id/files", () => ({
      workspaceId: "workspace-1",
      directory: "",
      entries: [],
    }));
    api.get("/api/workspaces/:id/files/content", () => ({
      workspaceId: "workspace-1",
      file: createDirectoryEntry({
        name: "index.ts",
        path: "src/index.ts",
        kind: "file",
        size: 20,
        versionToken: "100:20",
      }),
      content: "export const value = 1;\n",
    }));
    api.post("/api/workspaces/:id/files/write", () => {
      throw new MockApiError(409, {
        error: "file_conflict",
        message: "File changed outside the editor",
        currentFile: createDirectoryEntry({
          name: "index.ts",
          path: "src/index.ts",
          kind: "file",
          size: 25,
          versionToken: "200:25",
        }),
      });
    });

    const { result } = renderHook(() => useWorkspaceFiles("workspace-1"));
    await waitFor(() => {
      expect(result.current.loadingTree).toBe(false);
    });

    await act(async () => {
      await result.current.openFile("src/index.ts");
    });

    act(() => {
      result.current.setEditorContent("export const value = 3;\n");
    });

    await act(async () => {
      await result.current.saveCurrentFile();
    });

    expect(result.current.conflictState?.kind).toBe("save_conflict");
    expect(result.current.conflictState?.currentFile?.versionToken).toBe("200:25");
  });

  test("auto-reloads clean files when metadata changes externally", async () => {
    api.get("/api/workspaces/:id/files", () => ({
      workspaceId: "workspace-1",
      directory: "",
      entries: [],
    }));
    api.get("/api/workspaces/:id/files/content", (req) => ({
      workspaceId: "workspace-1",
      file: createDirectoryEntry({
        name: "index.ts",
        path: "src/index.ts",
        kind: "file",
        size: 20,
        versionToken: req.url.includes("reload=1") ? "200:20" : "100:20",
      }),
      content: req.url.includes("reload=1") ? "export const value = 2;\n" : "export const value = 1;\n",
    }));
    let metadataCallCount = 0;
    api.get("/api/workspaces/:id/files/metadata", () => {
      metadataCallCount += 1;
      return {
        workspaceId: "workspace-1",
        file: createDirectoryEntry({
          name: "index.ts",
          path: "src/index.ts",
          kind: "file",
          size: 20,
          versionToken: metadataCallCount > 1 ? "200:20" : "100:20",
        }),
      };
    });
    const originalReadApi = api.calls;
    void originalReadApi;

    const { result } = renderHook(() => useWorkspaceFiles("workspace-1"));
    await waitFor(() => {
      expect(result.current.loadingTree).toBe(false);
    });

    let readCount = 0;
    api.get("/api/workspaces/:id/files/content", () => {
      readCount += 1;
      return {
        workspaceId: "workspace-1",
        file: createDirectoryEntry({
          name: "index.ts",
          path: "src/index.ts",
          kind: "file",
          size: 20,
          versionToken: readCount > 1 ? "200:20" : "100:20",
        }),
        content: readCount > 1 ? "export const value = 2;\n" : "export const value = 1;\n",
      };
    });

    await act(async () => {
      await result.current.openFile("src/index.ts");
    });

    await act(async () => {
      await result.current.checkForExternalChanges();
      await result.current.checkForExternalChanges();
    });

    expect(result.current.savedContent).toBe("export const value = 2;\n");
    expect(result.current.autoReloadedAt).toBeTruthy();
  });

  test("prompts instead of auto-reloading when local edits exist", async () => {
    api.get("/api/workspaces/:id/files", () => ({
      workspaceId: "workspace-1",
      directory: "",
      entries: [],
    }));
    api.get("/api/workspaces/:id/files/content", () => ({
      workspaceId: "workspace-1",
      file: createDirectoryEntry({
        name: "index.ts",
        path: "src/index.ts",
        kind: "file",
        size: 20,
        versionToken: "100:20",
      }),
      content: "export const value = 1;\n",
    }));
    api.get("/api/workspaces/:id/files/metadata", () => ({
      workspaceId: "workspace-1",
      file: createDirectoryEntry({
        name: "index.ts",
        path: "src/index.ts",
        kind: "file",
        size: 25,
        versionToken: "200:25",
      }),
    }));

    const { result } = renderHook(() => useWorkspaceFiles("workspace-1"));
    await waitFor(() => {
      expect(result.current.loadingTree).toBe(false);
    });

    await act(async () => {
      await result.current.openFile("src/index.ts");
    });

    act(() => {
      result.current.setEditorContent("export const value = 999;\n");
    });

    await act(async () => {
      await result.current.checkForExternalChanges();
    });

    expect(result.current.conflictState?.kind).toBe("reload_conflict");
    expect(result.current.savedContent).toBe("export const value = 1;\n");
  });
});
