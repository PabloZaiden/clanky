import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor } from "../helpers/render";
import { createLoopWithStatus, createWorkspace } from "../helpers/factories";

mock.module("@monaco-editor/react", () => ({
  default: ({ value }: { value?: string }) => <div aria-label="Monaco editor">{value ?? ""}</div>,
}));

const api = createMockApi();
const ws = createMockWebSocket();

function installEmbeddedSshSessionMock() {
  mock.module("@/components/SshSessionDetails", () => ({
    SshSessionDetails: ({ sshSessionId }: { sshSessionId: string }) => (
      <div>Embedded SSH session: {sshSessionId}</div>
    ),
  }));
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
    installEmbeddedSshSessionMock();
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
    api.get("/api/config", () => ({ remoteOnly: false }));
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
      route: "#/workspace-files/workspace-files-1",
    });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Files Route Workspace editor" })).toBeInTheDocument();
      expect(getByRole("button", { name: "Terminals" })).toBeInTheDocument();
    });

    await user.click(getByRole("button", { name: "Terminals" }));
    await waitFor(() => {
      expect(getByRole("heading", { name: "Integrated terminal" })).toBeInTheDocument();
    });
  });

  test("passes the hash start directory through the initial explorer request", async () => {
    installEmbeddedSshSessionMock();
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
    api.get("/api/config", () => ({ remoteOnly: false }));
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
      route: "#/workspace-files/workspace-files-root?startDirectory=%2Fopt%2Fproject",
    });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Files Route Root editor" })).toBeInTheDocument();
    });
  });

  test("renders the loop files screen from the hash route, preserving the full loop id", async () => {
    installEmbeddedSshSessionMock();
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
    api.get("/api/config", () => ({ remoteOnly: false }));
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
      route: `#/loop-files/${loopId}`,
    });

    await waitFor(() => {
      expect(getByRole("heading", { name: "Loop Files Route editor" })).toBeInTheDocument();
    });
  });
});
