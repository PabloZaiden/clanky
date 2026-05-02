import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useServerFiles, useWorkspaceFiles } from "@/hooks";
import { clearStoredSshServerCredential, storeSshServerPassword } from "@/lib/ssh-browser-credentials";
import { createMockApi, MockApiError } from "../helpers/mock-api";

const api = createMockApi();
const TEST_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAsKNhd9E/OQ+lbqKlfYjv
69xGawOr9J0cMf2Qj3jWXaXv6mm1xrDBMYNboWkjxV6AZAG9zDJO6s8eP/rj7s3P
7dfmoHGRfqoItqqt6WkKxZxjrnDc0l43wcdGaGm0fL5f4enJv+0Ft9Y+BSHhMl+m
ENb+JvTFFK3bz38eLI8Td2RLIqjQ+bTR0M55VdlyIJvtZ4bAzn9IdABzd8hIp/Fq
ZI97s5nsyDqX5ePG7e9UY9kfF4sxhQ1jlwmkIYlQmVl3zY6fWihc+YVHL7XWE/90
cwJp+7qyc0w90j+5vMuJcfFm7F8FG7Zz+oOkkeNbeqMHEaJwVIi9vtHbljH5jtmd
Tib0ROswpXTuhp2cDEgfZiF5m6o6Yws1eIqUhYaEfpOUqseYjPe6Klbjyl90m7Xq
QpPbjq5q7UL/ase5r4n4t0JgcLZw1oP98rVAx+VFE+UViVd9qqH7CFhxxR9t7LFa
NwUWw/pj0oI3Qul2lJfXaogfXzdcguVRik/yi0zQ5p5ArRBPEtmeNcEqA9x1ApNQ
h8ND8r3lVAjFrX8+pj1fmPSxaIXgQPywAzr5kgdWz3BOEkrd5alvd+6kLxC2ErMA
tYXzrp47C+1F7elWjBhHsqlhHSl7zQxqXqetisXZ4uEyv+4S0M3O+Q+iLeidcbLQ
Vrt5VIv2q/QnK29KDywKJrsCAwEAAQ==
-----END PUBLIC KEY-----`;

function createDirectoryEntry(overrides?: Partial<{
  name: string;
  path: string;
  kind: "file" | "directory";
  loadOnExpand: boolean;
    size: number;
    modifiedAt: string;
    versionToken: string;
    mimeType: string;
    isImage: boolean;
  }>) {
  return {
    name: overrides?.name ?? "src",
    path: overrides?.path ?? "src",
    kind: overrides?.kind ?? "directory",
    loadOnExpand: overrides?.loadOnExpand,
    size: overrides?.size ?? 0,
    modifiedAt: overrides?.modifiedAt ?? "2026-01-01T00:00:00.000Z",
    versionToken: overrides?.versionToken ?? "100:0",
    mimeType: overrides?.mimeType,
    isImage: overrides?.isImage,
  };
}

function createTreeResponse(
  entriesByDirectory: Record<string, ReturnType<typeof createDirectoryEntry>[]>,
) {
  return { entriesByDirectory };
}

describe("useWorkspaceFiles", () => {
  beforeEach(() => {
    api.reset();
    api.install();
    URL.createObjectURL = () => "blob:preview";
    URL.revokeObjectURL = () => {};
    window.localStorage.clear();
    clearStoredSshServerCredential("server-1");
  });

  afterEach(() => {
    api.uninstall();
  });

  test("loads the root tree on mount", async () => {
    api.get("/api/workspaces/:id/files/tree", () => ({
      workspaceId: "workspace-1",
      ...createTreeResponse({
        "": [
          createDirectoryEntry(),
          createDirectoryEntry({
            name: "README.md",
            path: "README.md",
            kind: "file",
            size: 10,
            versionToken: "100:10",
          }),
        ],
        src: [],
      }),
    }));

    const { result } = renderHook(() => useWorkspaceFiles("workspace-1"));

    await waitFor(() => {
      expect(result.current.loadingTree).toBe(false);
    });

    expect(result.current.directoryEntries[""]?.map((entry) => entry.name)).toEqual(["src", "README.md"]);
  });

  test("toggles hidden files locally without refreshing expanded directories", async () => {
    api.get("/api/workspaces/:id/files/tree", () => ({
      workspaceId: "workspace-1",
      ...createTreeResponse({
        "": [
          createDirectoryEntry(),
          createDirectoryEntry({
            name: ".env",
            path: ".env",
            kind: "file",
            size: 10,
            versionToken: "100:10",
          }),
        ],
        src: [
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
        ],
      }),
    }));

    const { result } = renderHook(() => useWorkspaceFiles("workspace-1"));

    await waitFor(() => {
      expect(result.current.loadingTree).toBe(false);
    });

    await act(async () => {
      await result.current.toggleDirectory("src");
    });

    expect(result.current.directoryEntries[""]?.map((entry) => entry.name)).toEqual(["src", ".env"]);
    expect(result.current.directoryEntries["src"]?.map((entry) => entry.name)).toEqual([".secret.ts", "index.ts"]);
    expect(result.current.showHiddenFiles).toBe(true);
    expect(api.calls("/api/workspaces/:id/files/tree", "GET")).toHaveLength(1);

    await act(async () => {
      await result.current.toggleShowHiddenFiles();
    });

    expect(result.current.showHiddenFiles).toBe(false);
    expect(result.current.directoryEntries[""]?.map((entry) => entry.name)).toEqual(["src", ".env"]);
    expect(result.current.directoryEntries["src"]?.map((entry) => entry.name)).toEqual([".secret.ts", "index.ts"]);
    expect(api.calls("/api/workspaces/:id/files/tree", "GET")).toHaveLength(1);
  });

  test("supports opting back into lazy-loading mode", async () => {
    api.get("/api/workspaces/:id/files", (req) => {
      const url = new URL(req.url, "http://localhost");
      const path = url.searchParams.get("path") ?? "";

      if (path === "src") {
        return {
          workspaceId: "workspace-1",
          directory: "src",
          entries: [
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
          ],
        };
      }

      return {
        workspaceId: "workspace-1",
        directory: "",
        entries: [
          createDirectoryEntry(),
          createDirectoryEntry({
            name: ".env",
            path: ".env",
            kind: "file",
            size: 10,
            versionToken: "100:10",
          }),
        ],
      };
    });

    const { result } = renderHook(() => useWorkspaceFiles("workspace-1", { loadFullTree: false }));

    await waitFor(() => {
      expect(result.current.loadingTree).toBe(false);
    });

    await act(async () => {
      await result.current.toggleDirectory("src");
    });

    expect(result.current.directoryEntries[""]?.map((entry) => entry.name)).toEqual(["src", ".env"]);
    expect(result.current.directoryEntries["src"]?.map((entry) => entry.name)).toEqual([".secret.ts", "index.ts"]);
    expect(result.current.showHiddenFiles).toBe(true);
    expect(api.calls("/api/workspaces/:id/files", "GET")).toHaveLength(2);

    await act(async () => {
      await result.current.toggleShowHiddenFiles();
    });

    expect(result.current.showHiddenFiles).toBe(false);
    expect(result.current.directoryEntries[""]?.map((entry) => entry.name)).toEqual(["src", ".env"]);
    expect(result.current.directoryEntries["src"]?.map((entry) => entry.name)).toEqual([".secret.ts", "index.ts"]);
    expect(api.calls("/api/workspaces/:id/files", "GET")).toHaveLength(2);
  });

  test("defers heavy full-tree directories and lazily loads their subtree on expand", async () => {
    api.get("/api/workspaces/:id/files/tree", () => ({
      workspaceId: "workspace-1",
      ...createTreeResponse({
        "": [
          createDirectoryEntry({
            name: "node_modules",
            path: "node_modules",
            loadOnExpand: true,
          }),
        ],
      }),
    }));
    api.get("/api/workspaces/:id/files", (req) => {
      const url = new URL(req.url, "http://localhost");
      const path = url.searchParams.get("path") ?? "";

      if (path === "node_modules") {
        return {
          workspaceId: "workspace-1",
          directory: "node_modules",
          entries: [
            createDirectoryEntry({
              name: "pkg",
              path: "node_modules/pkg",
              kind: "directory",
            }),
          ],
        };
      }

      if (path === "node_modules/pkg") {
        return {
          workspaceId: "workspace-1",
          directory: "node_modules/pkg",
          entries: [
            createDirectoryEntry({
              name: "index.js",
              path: "node_modules/pkg/index.js",
              kind: "file",
            }),
          ],
        };
      }

      throw new MockApiError(500, {
        error: "unexpected_path",
        message: `Unexpected path: ${path}`,
      });
    });

    const { result } = renderHook(() => useWorkspaceFiles("workspace-1"));

    await waitFor(() => {
      expect(result.current.loadingTree).toBe(false);
    });

    expect(result.current.directoryEntries[""]?.map((entry) => entry.name)).toEqual(["node_modules"]);
    expect(result.current.directoryEntries["node_modules"]).toBeUndefined();

    await act(async () => {
      await result.current.toggleDirectory("node_modules");
    });

    expect(result.current.directoryEntries["node_modules"]?.map((entry) => entry.name)).toEqual(["pkg"]);

    await act(async () => {
      await result.current.toggleDirectory("node_modules/pkg");
    });

    expect(result.current.directoryEntries["node_modules/pkg"]?.map((entry) => entry.name)).toEqual(["index.js"]);
    expect(api.calls("/api/workspaces/:id/files", "GET")).toHaveLength(2);
  });

  test("collapses deferred directories removed by a full-tree refresh so they can reload on demand", async () => {
    api.get("/api/workspaces/:id/files/tree", () => ({
      workspaceId: "workspace-1",
      ...createTreeResponse({
        "": [
          createDirectoryEntry({
            name: "node_modules",
            path: "node_modules",
            loadOnExpand: true,
          }),
        ],
      }),
    }));
    api.get("/api/workspaces/:id/files", (req) => {
      const url = new URL(req.url, "http://localhost");
      const path = url.searchParams.get("path") ?? "";

      if (path === "node_modules") {
        return {
          workspaceId: "workspace-1",
          directory: "node_modules",
          entries: [
            createDirectoryEntry({
              name: "pkg",
              path: "node_modules/pkg",
              kind: "directory",
            }),
          ],
        };
      }

      throw new MockApiError(500, {
        error: "unexpected_path",
        message: `Unexpected path: ${path}`,
      });
    });

    const { result } = renderHook(() => useWorkspaceFiles("workspace-1"));

    await waitFor(() => {
      expect(result.current.loadingTree).toBe(false);
    });

    await act(async () => {
      await result.current.toggleDirectory("node_modules");
    });

    expect(result.current.expandedDirectories).toContain("node_modules");
    expect(result.current.directoryEntries["node_modules"]?.map((entry) => entry.name)).toEqual(["pkg"]);
    expect(api.calls("/api/workspaces/:id/files", "GET")).toHaveLength(1);

    await act(async () => {
      await result.current.refreshTree();
    });

    expect(result.current.expandedDirectories).not.toContain("node_modules");
    expect(result.current.directoryEntries["node_modules"]).toBeUndefined();

    await act(async () => {
      await result.current.toggleDirectory("node_modules");
    });

    expect(result.current.expandedDirectories).toContain("node_modules");
    expect(result.current.directoryEntries["node_modules"]?.map((entry) => entry.name)).toEqual(["pkg"]);
    expect(api.calls("/api/workspaces/:id/files", "GET")).toHaveLength(2);
  });

  test("opens a file, tracks dirty state, and saves successfully", async () => {
    api.get("/api/workspaces/:id/files/tree", () => ({
      workspaceId: "workspace-1",
      ...createTreeResponse({
        "": [createDirectoryEntry({
          name: "index.ts",
          path: "src/index.ts",
          kind: "file",
          size: 20,
          versionToken: "100:20",
        })],
      }),
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

  test("opens SVG files as image previews without reading text content", async () => {
    api.get("/api/workspaces/:id/files/tree", () => ({
      workspaceId: "workspace-1",
      ...createTreeResponse({
        "": [createDirectoryEntry({
          name: "logo.svg",
          path: "logo.svg",
          kind: "file",
          size: 120,
          versionToken: "100:120",
        })],
      }),
    }));
    api.get("/api/workspaces/:id/files/metadata", () => ({
      workspaceId: "workspace-1",
      file: createDirectoryEntry({
        name: "logo.svg",
        path: "logo.svg",
        kind: "file",
        size: 120,
        versionToken: "100:120",
        mimeType: "image/svg+xml",
        isImage: true,
      }),
    }));
    api.get("/api/workspaces/:id/files/preview", () => "<svg />");
    api.get("/api/workspaces/:id/files/content", () => {
      throw new Error("image files should not be read as text");
    });

    const { result } = renderHook(() => useWorkspaceFiles("workspace-1"));
    await waitFor(() => {
      expect(result.current.loadingTree).toBe(false);
    });

    await act(async () => {
      await result.current.openFile("logo.svg");
    });

    expect(result.current.currentFile?.isImage).toBe(true);
    expect(result.current.imagePreviewUrl).toBe("blob:preview");
    expect(result.current.editorContent).toBe("");
    expect(api.calls("/api/workspaces/:id/files/preview")).toHaveLength(1);
    expect(api.calls("/api/workspaces/:id/files/content")).toHaveLength(0);
  });

  test("surfaces save conflicts", async () => {
    api.get("/api/workspaces/:id/files/tree", () => ({
      workspaceId: "workspace-1",
      ...createTreeResponse({
        "": [],
      }),
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
        message: "File changed outside the code explorer",
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
    api.get("/api/workspaces/:id/files/tree", () => ({
      workspaceId: "workspace-1",
      ...createTreeResponse({
        "": [],
      }),
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
    api.get("/api/workspaces/:id/files/tree", () => ({
      workspaceId: "workspace-1",
      ...createTreeResponse({
        "": [],
      }),
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

  test("ignores stale poll reloads after a newer file is opened", async () => {
    api.get("/api/workspaces/:id/files/tree", () => ({
      workspaceId: "workspace-1",
      ...createTreeResponse({
        "": [],
      }),
    }));

    let firstFileReadCount = 0;
    let resolveStaleReload: ((value: unknown) => void) | null = null;

    api.get("/api/workspaces/:id/files/content", (req) => {
      const path = new URL(req.url, "http://localhost").searchParams.get("path");

      if (path === "src/first.ts") {
        firstFileReadCount += 1;
        if (firstFileReadCount === 1) {
          return {
            workspaceId: "workspace-1",
            file: createDirectoryEntry({
              name: "first.ts",
              path: "src/first.ts",
              kind: "file",
              size: 20,
              versionToken: "100:20",
            }),
            content: "export const first = 1;\n",
          };
        }
        return new Promise((resolve) => {
          resolveStaleReload = resolve;
        });
      }

      if (path === "src/second.ts") {
        return {
          workspaceId: "workspace-1",
          file: createDirectoryEntry({
            name: "second.ts",
            path: "src/second.ts",
            kind: "file",
            size: 21,
            versionToken: "101:21",
          }),
          content: "export const second = 2;\n",
        };
      }

      throw new Error(`Unexpected file path: ${path}`);
    });

    api.get("/api/workspaces/:id/files/metadata", (req) => {
      const path = new URL(req.url, "http://localhost").searchParams.get("path");
      if (path !== "src/first.ts") {
        throw new Error(`Unexpected metadata path: ${path}`);
      }
      return {
        workspaceId: "workspace-1",
        file: createDirectoryEntry({
          name: "first.ts",
          path: "src/first.ts",
          kind: "file",
          size: 20,
          versionToken: "200:20",
        }),
      };
    });

    const { result } = renderHook(() => useWorkspaceFiles("workspace-1"));
    await waitFor(() => {
      expect(result.current.loadingTree).toBe(false);
    });

    await act(async () => {
      await result.current.openFile("src/first.ts");
    });

    let stalePollPromise: Promise<void> | null = null;
    await act(async () => {
      stalePollPromise = result.current.checkForExternalChanges();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(resolveStaleReload).not.toBeNull();
    });

    await act(async () => {
      await result.current.openFile("src/second.ts");
    });

    await act(async () => {
      resolveStaleReload?.({
        workspaceId: "workspace-1",
        file: createDirectoryEntry({
          name: "first.ts",
          path: "src/first.ts",
          kind: "file",
          size: 20,
          versionToken: "200:20",
        }),
        content: "export const first = 200;\n",
      });
      await stalePollPromise;
    });

    expect(result.current.currentFile?.path).toBe("src/second.ts");
    expect(result.current.savedContent).toBe("export const second = 2;\n");
  });

  test("reuses the exchanged SSH credential token across repeated server metadata checks", async () => {
    api.get("/api/ssh-servers/:id/public-key", () => ({
      algorithm: "RSA-OAEP-256",
      publicKey: TEST_PUBLIC_KEY,
      fingerprint: "fingerprint",
      version: 1,
      createdAt: new Date().toISOString(),
    }));
    api.post("/api/ssh-servers/:id/credentials", () => ({
      credentialToken: "token-123",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
    api.get("/api/ssh-servers/:id/files/tree", () => ({
      serverId: "server-1",
      ...createTreeResponse({
        "": [],
      }),
    }));
    api.get("/api/ssh-servers/:id/files/content", () => ({
      serverId: "server-1",
      file: createDirectoryEntry({
        name: "index.ts",
        path: "src/index.ts",
        kind: "file",
        size: 20,
        versionToken: "100:20",
      }),
      content: "export const value = 1;\n",
    }));
    api.get("/api/ssh-servers/:id/files/metadata", () => ({
      serverId: "server-1",
      file: createDirectoryEntry({
        name: "index.ts",
        path: "src/index.ts",
        kind: "file",
        size: 20,
        versionToken: "100:20",
      }),
    }));

    await storeSshServerPassword("server-1", "super-secret");

    const { result } = renderHook(() => useServerFiles("server-1"));
    await waitFor(() => {
      expect(result.current.loadingTree).toBe(false);
    });

    await act(async () => {
      await result.current.openFile("src/index.ts");
    });

    const publicKeyCallCountBeforePolling = api.calls("/api/ssh-servers/:id/public-key", "GET").length;
    const credentialCallCountBeforePolling = api.calls("/api/ssh-servers/:id/credentials", "POST").length;

    await act(async () => {
      await result.current.checkForExternalChanges();
      await result.current.checkForExternalChanges();
    });

    expect(api.calls("/api/ssh-servers/:id/public-key", "GET")).toHaveLength(publicKeyCallCountBeforePolling);
    expect(api.calls("/api/ssh-servers/:id/credentials", "POST")).toHaveLength(credentialCallCountBeforePolling);
  });

  test("surfaces an invalid SSH credential error when the stored password is rejected", async () => {
    api.get("/api/ssh-servers/:id/public-key", () => ({
      algorithm: "RSA-OAEP-256",
      publicKey: TEST_PUBLIC_KEY,
      fingerprint: "fingerprint",
      version: 1,
      createdAt: new Date().toISOString(),
    }));
    api.post("/api/ssh-servers/:id/credentials", () => {
      throw new MockApiError(400, {
        error: "invalid_encrypted_credential",
        message: "Invalid SSH password",
      });
    });

    await storeSshServerPassword("server-1", "wrong-password");

    const { result } = renderHook(() => useServerFiles("server-1"));

    await waitFor(() => {
      expect(result.current.loadingTree).toBe(false);
    });

    expect(result.current.error).toBe("The SSH password for this server was rejected. Enter it again.");
  });

  test("preserves not_found server errors instead of classifying them as credential failures", async () => {
    api.get("/api/ssh-servers/:id/public-key", () => ({
      algorithm: "RSA-OAEP-256",
      publicKey: TEST_PUBLIC_KEY,
      fingerprint: "fingerprint",
      version: 1,
      createdAt: new Date().toISOString(),
    }));
    api.post("/api/ssh-servers/:id/credentials", () => {
      throw new MockApiError(404, {
        error: "not_found",
        message: "SSH server not found",
      });
    });

    await storeSshServerPassword("server-1", "super-secret");

    const { result } = renderHook(() => useServerFiles("server-1"));

    await waitFor(() => {
      expect(result.current.loadingTree).toBe(false);
    });

    expect(result.current.error).toBe("SSH server not found");
    expect(result.current.errorCode).toBeNull();
  });
});
