import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Chat } from "@/types";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor } from "../helpers/render";
import { createLoopWithStatus, createWorkspace } from "../helpers/factories";

mock.module("@monaco-editor/react", () => ({
  default: ({ value }: { value?: string }) => <div aria-label="Monaco editor">{value ?? ""}</div>,
}));

const api = createMockApi();
const ws = createMockWebSocket();

function createChat(overrides?: {
  config?: Partial<Chat["config"]>;
  state?: Partial<Chat["state"]>;
}): Chat {
  return {
    config: {
      id: "chat-1",
      name: "Repo pairing",
      workspaceId: "workspace-1",
      directory: "/workspaces/demo",
      model: {
        providerID: "github",
        modelID: "gpt-5.4",
        variant: "",
      },
      useWorktree: true,
      baseBranch: "main",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      mode: "chat",
      ...(overrides?.config ?? {}),
    },
    state: {
      id: overrides?.state?.id ?? overrides?.config?.id ?? "chat-1",
      status: "idle",
      messages: [],
      logs: [],
      toolCalls: [],
      ...(overrides?.state ?? {}),
    },
  };
}

describe("App workspace files route", () => {
  beforeEach(() => {
    api.reset();
    api.install();
    ws.reset();
    ws.install();
    window.location.hash = "";
  });

  afterEach(() => {
    api.uninstall();
    ws.uninstall();
    window.location.hash = "";
    mock.restore();
  });

  test("renders the workspace files screen from the hash route", async () => {
    const { App } = await import("@/App");
    const workspace = createWorkspace({
      id: "workspace-files-1",
      name: "Files Route Workspace",
      directory: "/workspaces/files-route",
    });

    api.get("/api/loops", () => []);
    api.get("/api/chats", () => []);
    api.get("/api/workspaces", () => [workspace]);
    api.get("/api/ssh-sessions", () => []);
    api.get("/api/ssh-servers", () => []);
    api.get("/api/config", () => ({ remoteOnly: false, passkeyAuth: { passkeyConfigured: false, passkeyDisabled: false, passkeyRequired: false, authenticated: false }, publicBasePath: null }));
    api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
    api.get("/api/preferences/last-model", () => null);
    api.get("/api/preferences/log-level", () => ({ level: "info" }));
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/models", () => []);
    api.get("/api/workspaces/:id/files", () => ({
      workspaceId: workspace.id,
      directory: "",
      entries: [],
    }));

    const { getByRole, user } = renderWithUser(<App />, {
      route: "#/code-explorer/workspace/workspace-files-1",
    });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Files Route Workspace code explorer" })).toBeInTheDocument();
      expect(getByRole("button", { name: "Terminals" })).toBeInTheDocument();
    });

    await user.click(getByRole("button", { name: "Terminals" }));
    await waitFor(() => {
      expect(getByRole("heading", { name: "Integrated terminal" })).toBeInTheDocument();
    });
  });

  test("passes the hash start directory through the initial explorer request", async () => {
    const { App } = await import("@/App");
    const workspace = createWorkspace({
      id: "workspace-files-root",
      name: "Files Route Root",
      directory: "/workspaces/files-route-root",
    });

    api.get("/api/loops", () => []);
    api.get("/api/chats", () => []);
    api.get("/api/workspaces", () => [workspace]);
    api.get("/api/ssh-sessions", () => []);
    api.get("/api/ssh-servers", () => []);
    api.get("/api/config", () => ({ remoteOnly: false, passkeyAuth: { passkeyConfigured: false, passkeyDisabled: false, passkeyRequired: false, authenticated: false }, publicBasePath: null }));
    api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
    api.get("/api/preferences/last-model", () => null);
    api.get("/api/preferences/log-level", () => ({ level: "info" }));
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/models", () => []);
    api.get("/api/workspaces/:id/files", (req) => {
      const startDirectory = new URL(req.url, "http://localhost").searchParams.get("startDirectory");
      expect(startDirectory).toBe("/opt/project");
      return {
        workspaceId: workspace.id,
        directory: "",
        entries: [],
      };
    });

    const { getByRole } = renderWithUser(<App />, {
      route: "#/code-explorer/workspace/workspace-files-root?startDirectory=%2Fopt%2Fproject",
    });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Files Route Root code explorer" })).toBeInTheDocument();
    });
  });

  test("renders the generic code explorer picker from the hash route", async () => {
    const { App } = await import("@/App");
    const workspace = createWorkspace({
      id: "workspace-files-picker",
      name: "Picker Workspace",
      directory: "/workspaces/picker",
    });
    const loop = createLoopWithStatus("idle", {
      config: {
        id: "picker-loop",
        name: "Picker Loop",
        workspaceId: workspace.id,
        directory: workspace.directory,
      },
    });

    api.get("/api/loops", () => [loop]);
    api.get("/api/chats", () => []);
    api.get("/api/workspaces", () => [workspace]);
    api.get("/api/ssh-sessions", () => []);
    api.get("/api/ssh-servers", () => []);
    api.get("/api/config", () => ({ remoteOnly: false, passkeyAuth: { passkeyConfigured: false, passkeyDisabled: false, passkeyRequired: false, authenticated: false }, publicBasePath: null }));
    api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
    api.get("/api/preferences/last-model", () => null);
    api.get("/api/preferences/log-level", () => ({ level: "info" }));
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/models", () => []);
    api.get("/api/workspaces/:id/files", () => ({
      workspaceId: workspace.id,
      directory: "",
      entries: [],
    }));

    const { getByLabelText, getByRole } = renderWithUser(<App />, {
      route: "#/code-explorer",
    });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Code explorer" })).toBeInTheDocument();
      expect(getByLabelText("Select code explorer content")).toBeInTheDocument();
    });
  });

  test("renders the loop files screen from the hash route, preserving the full loop id", async () => {
    const { App } = await import("@/App");
    const workspace = createWorkspace({
      id: "workspace-loop-files",
      name: "Loop Files Workspace",
      directory: "/workspaces/loop-files",
      serverSettings: {
        agent: {
          provider: "opencode",
          transport: "ssh",
          hostname: "remote.example",
          username: "tester",
        },
      },
    });
    const loopId = "xloop-files-1";
    const worktreePath = `/workspaces/loop-files/.ralph-worktrees/${loopId}`;
    const loop = createLoopWithStatus("running", {
      config: {
        id: loopId,
        name: "Loop Files Route",
        workspaceId: workspace.id,
        directory: workspace.directory,
        useWorktree: true,
      },
      state: {
        git: {
          originalBranch: "main",
          workingBranch: "loop-files-route",
          commits: [],
          worktreePath,
        },
      },
    });

    api.get("/api/loops", () => [loop]);
    api.get("/api/chats", () => []);
    api.get("/api/workspaces", () => [workspace]);
    api.get("/api/ssh-sessions", () => []);
    api.get("/api/ssh-servers", () => []);
    api.get("/api/config", () => ({ remoteOnly: false, passkeyAuth: { passkeyConfigured: false, passkeyDisabled: false, passkeyRequired: false, authenticated: false }, publicBasePath: null }));
    api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
    api.get("/api/preferences/last-model", () => null);
    api.get("/api/preferences/log-level", () => ({ level: "info" }));
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/models", () => []);
    api.get("/api/workspaces/:id/files", (req) => {
      const startDirectory = new URL(req.url, "http://localhost").searchParams.get("startDirectory");
      expect(startDirectory).toBe(worktreePath);
      return {
        workspaceId: workspace.id,
        directory: "",
        entries: [],
      };
    });

    const { getByRole } = renderWithUser(<App />, {
      route: `#/code-explorer/loop/${loopId}`,
    });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Loop Files Route code explorer" })).toBeInTheDocument();
    });
  });

  test("opens the requested file from the code explorer hash route", async () => {
    const { App } = await import("@/App");
    const workspace = createWorkspace({
      id: "workspace-files-open-file",
      name: "Open File Workspace",
      directory: "/workspaces/open-file",
    });

    api.get("/api/loops", () => []);
    api.get("/api/chats", () => []);
    api.get("/api/workspaces", () => [workspace]);
    api.get("/api/ssh-sessions", () => []);
    api.get("/api/ssh-servers", () => []);
    api.get("/api/config", () => ({ remoteOnly: false, passkeyAuth: { passkeyConfigured: false, passkeyDisabled: false, passkeyRequired: false, authenticated: false }, publicBasePath: null }));
    api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
    api.get("/api/preferences/last-model", () => null);
    api.get("/api/preferences/log-level", () => ({ level: "info" }));
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/file-explorer-full-tree", () => ({ enabled: false }));
    api.get("/api/models", () => []);
    api.get("/api/workspaces/:id/files", (req) => {
      const url = new URL(req.url, "http://localhost");
      const path = url.searchParams.get("path") ?? "";
      if (path === "") {
        return {
          workspaceId: workspace.id,
          directory: "",
          entries: [
            {
              name: "src",
              path: "src",
              kind: "directory",
            },
          ],
        };
      }

      expect(path).toBe("src");
      return {
        workspaceId: workspace.id,
        directory: "src",
        entries: [
          {
            name: "index.ts",
            path: "src/index.ts",
            kind: "file",
          },
        ],
      };
    });
    api.get("/api/workspaces/:id/files/content", (req) => {
      const path = new URL(req.url, "http://localhost").searchParams.get("path");
      expect(path).toBe("src/index.ts");
      return {
        workspaceId: workspace.id,
        file: {
          name: "index.ts",
          path: "src/index.ts",
          kind: "file",
          size: 24,
          modifiedAt: "2026-01-01T00:00:00.000Z",
          versionToken: "100:24",
        },
        content: "export const opened = true;\n",
      };
    });

    const { getByLabelText, getByRole } = renderWithUser(<App />, {
      route: "#/code-explorer/workspace/workspace-files-open-file?filePath=src%2Findex.ts",
    });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Open File Workspace code explorer" })).toBeInTheDocument();
      expect(api.calls("/api/workspaces/:id/files/content", "GET")).toHaveLength(1);
      expect(getByLabelText("Monaco editor")).toHaveTextContent("export const opened = true;");
    });
  });

  test("waits for the file explorer preference before auto-opening a chat file route", async () => {
    const { App } = await import("@/App");
    const workspace = createWorkspace({
      id: "workspace-chat-open-file",
      name: "Chat Open File Workspace",
      directory: "/workspaces/demo",
    });
    const chatWorktreePath = "/workspaces/demo/.chat-worktree";
    const chat = createChat({
      config: {
        id: "chat-open-file",
        workspaceId: workspace.id,
        directory: workspace.directory,
      },
      state: {
        worktree: {
          originalBranch: "main",
          workingBranch: "chat-open-file",
          worktreePath: chatWorktreePath,
        },
      },
    });

    api.get("/api/loops", () => []);
    api.get("/api/chats", () => [chat]);
    api.get("/api/chats/:id", () => chat);
    api.get("/api/workspaces", () => [workspace]);
    api.get("/api/ssh-sessions", () => []);
    api.get("/api/ssh-servers", () => []);
    api.get("/api/config", () => ({ remoteOnly: false, passkeyAuth: { passkeyConfigured: false, passkeyDisabled: false, passkeyRequired: false, authenticated: false }, publicBasePath: null }));
    api.get("/api/health", () => ({ status: "ok", version: "1.0.0" }));
    api.get("/api/preferences/last-model", () => null);
    api.get("/api/preferences/log-level", () => ({ level: "info" }));
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/file-explorer-full-tree", async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { enabled: true };
    });
    api.get("/api/models", () => []);
    api.get("/api/workspaces/:id/files/tree", (req) => {
      const startDirectory = new URL(req.url, "http://localhost").searchParams.get("startDirectory");
      expect(startDirectory).toBe(chatWorktreePath);
      return {
        workspaceId: workspace.id,
        entriesByDirectory: {
          "": [
            {
              name: "src",
              path: "src",
              kind: "directory",
            },
          ],
        },
      };
    });
    api.get("/api/workspaces/:id/files/content", (req) => {
      const url = new URL(req.url, "http://localhost");
      expect(url.searchParams.get("startDirectory")).toBe(chatWorktreePath);
      expect(url.searchParams.get("path")).toBe("src/index.ts");
      return {
        workspaceId: workspace.id,
        file: {
          name: "index.ts",
          path: "src/index.ts",
          kind: "file",
          size: 24,
          modifiedAt: "2026-01-01T00:00:00.000Z",
          versionToken: "100:24",
        },
        content: "export const opened = true;\n",
      };
    });

    const { getByLabelText, getByRole } = renderWithUser(<App />, {
      route: `#/code-explorer/chat/${chat.config.id}?startDirectory=${encodeURIComponent(chatWorktreePath)}&filePath=src%2Findex.ts`,
    });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Repo pairing code explorer" })).toBeInTheDocument();
      expect(api.calls("/api/workspaces/:id/files/tree", "GET")).toHaveLength(1);
      expect(api.calls("/api/workspaces/:id/files/content", "GET")).toHaveLength(1);
      expect(getByLabelText("Monaco editor")).toHaveTextContent("export const opened = true;");
    });
  });
});
