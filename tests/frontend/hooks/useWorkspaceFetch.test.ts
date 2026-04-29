import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { useWorkspaceFetch } from "@/hooks/workspace-server-settings/use-fetch";
import { createWorkspace } from "../helpers/factories";
import { createMockApi } from "../helpers/mock-api";

const api = createMockApi();

beforeEach(() => {
  api.reset();
  api.install();
});

afterEach(() => {
  api.uninstall();
});

describe("useWorkspaceFetch", () => {
  test("requests sensitive workspace data for the settings editor", async () => {
    const workspace = createWorkspace({ id: "ws-sensitive" });
    api.get("/api/workspaces/:id", (req) => {
      expect(req.params["id"]).toBe("ws-sensitive");
      expect(req.url).toContain("/api/workspaces/ws-sensitive?sensitive=true");
      return workspace;
    });
    api.get("/api/workspaces/:id/server-settings/status", () => ({
      connected: true,
      provider: "opencode",
      transport: "stdio",
      capabilities: [],
    }));

    const { result } = renderHook(() => useWorkspaceFetch("ws-sensitive"));

    await act(async () => {
      await result.current.fetchWorkspace();
    });

    expect(result.current.workspace).toEqual(workspace);
  });
});
