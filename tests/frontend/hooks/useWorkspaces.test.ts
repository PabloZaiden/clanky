/**
 * Tests for useWorkspaces hook.
 *
 * Tests CRUD operations, loading/error/saving states, and API edge cases.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { renderHook, waitFor, act } from "@testing-library/react";
import { createMockApi, MockApiError } from "../helpers/mock-api";
import { createWorkspace, createServerSettings } from "../helpers/factories";
import { useWorkspaces } from "@/hooks/useWorkspaces";

const api = createMockApi();

beforeEach(() => {
  api.reset();
  api.install();
});

afterEach(() => {
  api.uninstall();
});

/**
 * Helper to set up the default GET /api/workspaces mock.
 * Most tests need the initial fetch to succeed.
 */
function setupWorkspacesList(workspaces = [createWorkspace()]) {
  api.get("/api/workspaces", () => workspaces);
  return workspaces;
}

// ─── Initial fetch ───────────────────────────────────────────────────────────

describe("initial fetch", () => {
  test("fetches workspaces on mount and sets loading to false", async () => {
    const workspaces = setupWorkspacesList();
    const { result } = renderHook(() => useWorkspaces());

    // Initially loading
    expect(result.current.loading).toBe(true);

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.workspaces).toEqual(workspaces);
    expect(result.current.error).toBeNull();
  });

  test("sets error when fetch fails", async () => {
    api.get("/api/workspaces", () => {
      throw new MockApiError(500, { message: "Server error" });
    });

    const { result } = renderHook(() => useWorkspaces());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBeTruthy();
    expect(result.current.workspaces).toEqual([]);
  });

  test("returns empty array when no workspaces exist", async () => {
    setupWorkspacesList([]);
    const { result } = renderHook(() => useWorkspaces());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.workspaces).toEqual([]);
    expect(result.current.error).toBeNull();
  });
});

// ─── createWorkspace ─────────────────────────────────────────────────────────

describe("createWorkspace", () => {
  test("sends POST request and returns created workspace", async () => {
    const workspaces = setupWorkspacesList([]);
    const newWorkspace = createWorkspace({ id: "ws-new", name: "New WS" });

    api.post("/api/workspaces", () => newWorkspace);
    // After create, it refreshes the list
    let callCount = 0;
    api.get("/api/workspaces", () => {
      callCount++;
      return callCount > 1 ? [createWorkspace({ ...newWorkspace })] : workspaces;
    });

    const { result } = renderHook(() => useWorkspaces());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let created: ReturnType<typeof createWorkspace> | null = null;
    await act(async () => {
      created = await result.current.createWorkspace({
        name: "New WS",
        directory: "/workspaces/new",
        serverSettings: createServerSettings(),
      });
    });

    expect(created).not.toBeNull();
    expect(created!).toEqual(newWorkspace);
    expect(result.current.saving).toBe(false);

    const postCalls = api.calls("/api/workspaces", "POST");
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]!.body).toEqual({
      name: "New WS",
      directory: "/workspaces/new",
      serverSettings: {
        agent: { provider: "opencode", transport: "stdio" },
      },
    });
  });

  test("handles legacy 409 conflict gracefully by returning existing workspace", async () => {
    // This tests the frontend's defensive handling of 409 responses.
    // The API no longer returns 409 for duplicate directories, but the
    // frontend gracefully handles it for backward compatibility.
    setupWorkspacesList();
    const existingWorkspace = createWorkspace({ id: "ws-existing", name: "Existing" });

    api.post("/api/workspaces", () => {
      throw new MockApiError(409, {
        message: "Workspace already exists",
        existingWorkspace,
      });
    });

    const { result } = renderHook(() => useWorkspaces());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let created: ReturnType<typeof createWorkspace> | null = null;
    await act(async () => {
      created = await result.current.createWorkspace({
        name: "Existing",
        directory: "/workspaces/existing",
        serverSettings: createServerSettings(),
      });
    });

    expect(created).not.toBeNull();
    expect(created!).toEqual(existingWorkspace);
    expect(result.current.error).toBeNull();
  });

  test("sets error and returns null on non-409 failure", async () => {
    setupWorkspacesList();
    api.post("/api/workspaces", () => {
      throw new MockApiError(400, { message: "Invalid directory" });
    });

    const { result } = renderHook(() => useWorkspaces());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let created: ReturnType<typeof createWorkspace> | null = null;
    await act(async () => {
      created = await result.current.createWorkspace({
        name: "Bad",
        directory: "not-a-path",
        serverSettings: createServerSettings(),
      });
    });

    expect(created).toBeNull();
    expect(result.current.error).toBeTruthy();
    expect(result.current.saving).toBe(false);
  });
});

// ─── updateWorkspace ─────────────────────────────────────────────────────────

describe("updateWorkspace", () => {
  test("sends PUT request and returns updated workspace", async () => {
    const ws = createWorkspace({ id: "ws-1", name: "Old Name" });
    setupWorkspacesList([ws]);
    const updated = createWorkspace({ id: "ws-1", name: "New Name" });

    api.put("/api/workspaces/:id", () => updated);

    const { result } = renderHook(() => useWorkspaces());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let updatedResult: ReturnType<typeof createWorkspace> | null = null;
    await act(async () => {
      updatedResult = await result.current.updateWorkspace("ws-1", "New Name");
    });

    expect(updatedResult).not.toBeNull();
    expect(updatedResult!).toEqual(updated);
    const putCalls = api.calls("/api/workspaces/:id", "PUT");
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0]!.body).toEqual({ name: "New Name" });
  });

  test("sets error and returns null on failure", async () => {
    setupWorkspacesList();
    api.put("/api/workspaces/:id", () => {
      throw new MockApiError(404, { message: "Workspace not found" });
    });

    const { result } = renderHook(() => useWorkspaces());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let updatedResult: ReturnType<typeof createWorkspace> | null = null;
    await act(async () => {
      updatedResult = await result.current.updateWorkspace("ws-999", "Name");
    });

    expect(updatedResult).toBeNull();
    expect(result.current.error).toBeTruthy();
  });
});

// ─── deleteWorkspace ─────────────────────────────────────────────────────────

describe("deleteWorkspace", () => {
  test("sends DELETE request and returns success", async () => {
    setupWorkspacesList();
    api.delete("/api/workspaces/:id", () => ({ success: true }));

    const { result } = renderHook(() => useWorkspaces());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let deleteResult: { success: boolean; error?: string } = { success: false };
    await act(async () => {
      deleteResult = await result.current.deleteWorkspace("ws-1");
    });

    expect(deleteResult).toEqual({ success: true });
    expect(api.calls("/api/workspaces/:id", "DELETE")).toHaveLength(1);
  });

  test("returns error object on failure without setting error state (for non-throw path)", async () => {
    setupWorkspacesList();
    api.delete("/api/workspaces/:id", () => {
      throw new MockApiError(409, { message: "Workspace has tasks" });
    });

    const { result } = renderHook(() => useWorkspaces());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let deleteResult: { success: boolean; error?: string } = { success: false };
    await act(async () => {
      deleteResult = await result.current.deleteWorkspace("ws-1");
    });

    expect(deleteResult.success).toBe(false);
    expect(deleteResult.error).toBe("Workspace has tasks");
  });

  test("returns fallback error message when no message in response", async () => {
    setupWorkspacesList();
    api.delete("/api/workspaces/:id", () => {
      throw new MockApiError(500, {});
    });

    const { result } = renderHook(() => useWorkspaces());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let deleteResult: { success: boolean; error?: string } = { success: false };
    await act(async () => {
      deleteResult = await result.current.deleteWorkspace("ws-1");
    });

    expect(deleteResult.success).toBe(false);
    expect(deleteResult.error).toBe("Failed to delete workspace");
  });
});

// ─── refresh ─────────────────────────────────────────────────────────────────

describe("refresh", () => {
  test("re-fetches workspaces list", async () => {
    const ws1 = createWorkspace({ id: "ws-1", name: "WS 1" });
    const ws2 = createWorkspace({ id: "ws-2", name: "WS 2" });

    let callCount = 0;
    api.get("/api/workspaces", () => {
      callCount++;
      return callCount === 1 ? [ws1] : [ws1, ws2];
    });

    const { result } = renderHook(() => useWorkspaces());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.workspaces).toHaveLength(1);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.workspaces).toHaveLength(2);
    expect(api.calls("/api/workspaces", "GET")).toHaveLength(2);
  });
});

// ─── exportConfig ────────────────────────────────────────────────────────────

describe("exportConfig", () => {
  test("calls GET /api/workspaces/export and returns data", async () => {
    setupWorkspacesList();

    const exportData = {
      version: 1,
      exportedAt: "2026-02-10T12:00:00.000Z",
      workspaces: [
        {
          name: "WS 1",
          directory: "/workspaces/ws1",
          serverSettings: createServerSettings({ mode: "spawn" }),
        },
      ],
    };

    api.get("/api/workspaces/export", (req) => {
      expect(req.url).toContain("/api/workspaces/export?sensitive=true");
      return exportData;
    });

    const { result } = renderHook(() => useWorkspaces());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let exported: unknown = null;
    await act(async () => {
      exported = await result.current.exportConfig();
    });

    expect(exported).toEqual(exportData);
    expect(api.calls("/api/workspaces/export", "GET")).toHaveLength(1);
    expect(result.current.saving).toBe(false);
  });

  test("sets error and returns null on failure", async () => {
    setupWorkspacesList();
    api.get("/api/workspaces/export", () => {
      throw new MockApiError(500, { message: "Export failed" });
    });

    const { result } = renderHook(() => useWorkspaces());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let exported: unknown = null;
    await act(async () => {
      exported = await result.current.exportConfig();
    });

    expect(exported).toBeNull();
    expect(result.current.error).toBeTruthy();
    expect(result.current.saving).toBe(false);
  });
});

// ─── importConfig ────────────────────────────────────────────────────────────

describe("importConfig", () => {
  test("POSTs to /api/workspaces/import and returns result", async () => {
    setupWorkspacesList();

    const importData = {
      version: 1 as const,
      exportedAt: "2026-02-10T12:00:00.000Z",
      workspaces: [
        {
          name: "Imported WS",
          directory: "/workspaces/imported",
          serverSettings: createServerSettings({
            mode: "connect",
            hostname: "host.com",
            port: 3000,
          }),
        },
      ],
    };

    const importResult = {
      created: 1,
      skipped: 0,
      failed: 0,
      details: [{ name: "Imported WS", directory: "/workspaces/imported", status: "created" }],
    };

    api.post("/api/workspaces/import", () => importResult);

    const { result } = renderHook(() => useWorkspaces());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let returned: unknown = null;
    await act(async () => {
      returned = await result.current.importConfig(importData);
    });

    expect(returned).toEqual(importResult);

    // Verify POST was made with correct body
    const postCalls = api.calls("/api/workspaces/import", "POST");
    expect(postCalls).toHaveLength(1);
    expect(postCalls[0]!.body).toEqual(importData);
    expect(result.current.saving).toBe(false);
  });

  test("refreshes workspace list after successful import", async () => {
    const ws1 = createWorkspace({ id: "ws-1", name: "WS 1" });
    const ws2 = createWorkspace({ id: "ws-2", name: "WS 2" });

    let getCallCount = 0;
    api.get("/api/workspaces", () => {
      getCallCount++;
      return getCallCount === 1 ? [ws1] : [ws1, ws2];
    });

    api.post("/api/workspaces/import", () => ({
      created: 1,
      skipped: 0,
      failed: 0,
      details: [{ name: "WS 2", directory: "/workspaces/ws2", status: "created" }],
    }));

    const { result } = renderHook(() => useWorkspaces());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.workspaces).toHaveLength(1);

    await act(async () => {
      await result.current.importConfig({
        version: 1,
        exportedAt: "2026-02-10T12:00:00.000Z",
        workspaces: [
          {
            name: "WS 2",
            directory: "/workspaces/ws2",
            serverSettings: createServerSettings({ mode: "spawn" }),
          },
        ],
      });
    });

    // Should have refreshed the list — now 2 workspaces
    expect(result.current.workspaces).toHaveLength(2);
    // Initial fetch + refresh after import
    expect(api.calls("/api/workspaces", "GET").length).toBeGreaterThanOrEqual(2);
  });

  test("sets error and returns null on failure", async () => {
    setupWorkspacesList();
    api.post("/api/workspaces/import", () => {
      throw new MockApiError(400, { message: "Invalid import data" });
    });

    const { result } = renderHook(() => useWorkspaces());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    let returned: unknown = null;
    await act(async () => {
      returned = await result.current.importConfig({
        version: 1,
        exportedAt: "2026-02-10T12:00:00.000Z",
        workspaces: [],
      });
    });

    expect(returned).toBeNull();
    expect(result.current.error).toBeTruthy();
    expect(result.current.saving).toBe(false);
  });
});
