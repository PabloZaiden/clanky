import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor } from "../helpers/render";
import { createWorkspace } from "../helpers/factories";

mock.module("@monaco-editor/react", () => ({
  default: ({ value }: { value?: string }) => <div aria-label="Monaco editor">{value ?? ""}</div>,
}));

mock.module("@/components/SshSessionDetails", () => ({
  SshSessionDetails: ({ sshSessionId }: { sshSessionId: string }) => (
    <div>Embedded SSH session: {sshSessionId}</div>
  ),
}));

const { App } = await import("@/App");

const api = createMockApi();
const ws = createMockWebSocket();

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
  });

  test("renders the workspace files screen from the hash route", async () => {
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
});
