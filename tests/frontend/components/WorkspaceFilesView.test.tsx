import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockApi } from "../helpers/mock-api";
import { renderWithUser, waitFor } from "../helpers/render";
import { createSshSession, createWorkspace } from "../helpers/factories";

mock.module("@monaco-editor/react", () => ({
  default: ({
    value,
    onChange,
  }: {
    value?: string;
    onChange?: (value: string) => void;
  }) => (
    <textarea
      aria-label="Monaco editor"
      value={value ?? ""}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

const api = createMockApi();

function installEmbeddedSshSessionMock() {
  mock.module("@/components/SshSessionDetails", () => ({
    SshSessionDetails: ({
      sshSessionId,
      forcedFocusMode,
    }: {
      sshSessionId: string;
      forcedFocusMode?: boolean;
    }) => (
      <div>
        Embedded SSH session: {sshSessionId}
        {forcedFocusMode ? " (focused)" : ""}
      </div>
    ),
  }));
}

function createFileEntry(overrides?: Partial<{
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

describe("WorkspaceFilesView", () => {
  beforeEach(() => {
    api.reset();
    api.install();
  });

  afterEach(() => {
    api.uninstall();
    mock.restore();
  });

  test("opens files from the tree and enables saving edited content", async () => {
    installEmbeddedSshSessionMock();
    const { WorkspaceFilesView } = await import("@/components/app-shell/workspace-files-view");
    const workspace = createWorkspace({
      id: "workspace-1",
      name: "Editor Workspace",
      directory: "/workspaces/editor-workspace",
    });

    api.get("/api/workspaces/:id/files", (req) => {
      const path = new URL(req.url, "http://localhost").searchParams.get("path") ?? "";
      if (path === "src") {
        return {
          workspaceId: workspace.id,
          directory: "src",
          entries: [createFileEntry({
            name: "index.ts",
            path: "src/index.ts",
            kind: "file",
            size: 20,
            versionToken: "100:20",
          })],
        };
      }
      return {
        workspaceId: workspace.id,
        directory: "",
        entries: [createFileEntry()],
      };
    });

    api.get("/api/workspaces/:id/files/content", () => ({
      workspaceId: workspace.id,
      file: createFileEntry({
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
      workspaceId: workspace.id,
      overwritten: false,
      file: createFileEntry({
        name: "index.ts",
        path: "src/index.ts",
        kind: "file",
        size: 20,
        versionToken: "200:20",
      }),
    }));

    const { getByRole, getByLabelText, user } = renderWithUser(
      <WorkspaceFilesView
        workspace={workspace}
        sessions={[]}
        createSession={async () => createSshSession()}
        onNavigate={() => {}}
      />,
    );

    await waitFor(() => {
      expect(getByRole("button", { name: /src/i })).toBeInTheDocument();
    });

    await user.click(getByRole("button", { name: /src/i }));
    await waitFor(() => {
      expect(getByRole("button", { name: /index.ts/i })).toBeInTheDocument();
    });

    await user.click(getByRole("button", { name: /index.ts/i }));
    await waitFor(() => {
      expect(getByLabelText("Monaco editor")).toBeInTheDocument();
    });

    await user.clear(getByLabelText("Monaco editor"));
    await user.type(getByLabelText("Monaco editor"), "export const value = 2;");
    await user.click(getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(api.calls("/api/workspaces/:id/files/write", "POST")).toHaveLength(1);
    });
  });

  test("shows existing SSH sessions and can create a new terminal session", async () => {
    installEmbeddedSshSessionMock();
    const { WorkspaceFilesView } = await import("@/components/app-shell/workspace-files-view");
    const workspace = createWorkspace({
      id: "workspace-ssh",
      name: "SSH Workspace",
      directory: "/workspaces/ssh-workspace",
      serverSettings: {
        agent: {
          provider: "opencode",
          transport: "ssh",
          hostname: "remote.example",
          username: "tester",
        },
      },
    });
    const session = createSshSession({
      config: {
        id: "session-1",
        workspaceId: workspace.id,
        name: "Workspace SSH",
      },
    });
    const createSession = mock(async () => createSshSession({
      config: {
        id: "session-2",
        workspaceId: workspace.id,
        name: "Created SSH",
      },
    }));

    api.get("/api/workspaces/:id/files", () => ({
      workspaceId: workspace.id,
      directory: "",
      entries: [],
    }));

    const { getByRole, getByText, queryByText, user } = renderWithUser(
      <WorkspaceFilesView
        workspace={workspace}
        sessions={[session]}
        createSession={createSession}
        onNavigate={() => {}}
      />,
    );

    expect(queryByText("Reuses workspace SSH sessions where available.")).not.toBeInTheDocument();

    await user.click(getByRole("button", { name: "Terminals" }));
    await waitFor(() => {
      expect(getByRole("combobox", { name: "Select workspace SSH session" })).toBeInTheDocument();
      expect(getByText("Embedded SSH session: session-1 (focused)")).toBeInTheDocument();
    });

    await user.click(getByRole("button", { name: /New terminal/i }));
    await waitFor(() => {
      expect(createSession).toHaveBeenCalledTimes(1);
    });
  });

  test("can collapse and expand the file explorer pane", async () => {
    installEmbeddedSshSessionMock();
    const { WorkspaceFilesView } = await import("@/components/app-shell/workspace-files-view");
    const workspace = createWorkspace({
      id: "workspace-collapse",
      name: "Explorer Collapse",
      directory: "/workspaces/explorer-collapse",
    });

    api.get("/api/workspaces/:id/files", () => ({
      workspaceId: workspace.id,
      directory: "",
      entries: [createFileEntry()],
    }));

    const { getByRole, queryByRole, user } = renderWithUser(
      <WorkspaceFilesView
        workspace={workspace}
        sessions={[]}
        createSession={async () => createSshSession()}
        onNavigate={() => {}}
      />,
    );

    await waitFor(() => {
      expect(getByRole("button", { name: /src/i })).toBeInTheDocument();
    });

    await user.click(getByRole("button", { name: "Collapse file explorer" }));
    expect(queryByRole("button", { name: /src/i })).not.toBeInTheDocument();

    await user.click(getByRole("button", { name: "Expand file explorer" }));
    await waitFor(() => {
      expect(getByRole("button", { name: /src/i })).toBeInTheDocument();
    });
  });

  test("keeps the mobile collapsed explorer controls available for re-expanding", async () => {
    installEmbeddedSshSessionMock();
    const { WorkspaceFilesView } = await import("@/components/app-shell/workspace-files-view");
    const workspace = createWorkspace({
      id: "workspace-mobile-collapse",
      name: "Mobile Explorer Collapse",
      directory: "/workspaces/mobile-explorer-collapse",
    });

    api.get("/api/workspaces/:id/files", () => ({
      workspaceId: workspace.id,
      directory: "",
      entries: [createFileEntry()],
    }));

    const { getAllByText, getByRole, queryByRole, user } = renderWithUser(
      <WorkspaceFilesView
        workspace={workspace}
        sessions={[]}
        createSession={async () => createSshSession()}
        onNavigate={() => {}}
      />,
    );

    await waitFor(() => {
      expect(getByRole("button", { name: /src/i })).toBeInTheDocument();
    });

    await user.click(getByRole("button", { name: "Collapse file explorer" }));

    expect(queryByRole("button", { name: /src/i })).not.toBeInTheDocument();
    expect(getByRole("button", { name: "Expand file explorer" })).toBeInTheDocument();
    expect(getByRole("button", { name: "Files" })).toBeInTheDocument();
    expect(getByRole("button", { name: "Terminals" })).toBeInTheDocument();
    expect(getAllByText("Files").length).toBeGreaterThan(0);

    await user.click(getByRole("button", { name: "Expand file explorer" }));
    await waitFor(() => {
      expect(getByRole("button", { name: /src/i })).toBeInTheDocument();
    });
  });

  test("removes non-essential legends and keeps refresh actions icon-only", async () => {
    installEmbeddedSshSessionMock();
    const { WorkspaceFilesView } = await import("@/components/app-shell/workspace-files-view");
    const workspace = createWorkspace({
      id: "workspace-chrome",
      name: "Minimal Chrome",
      directory: "/workspaces/minimal-chrome",
    });

    api.get("/api/workspaces/:id/files", (req) => {
      const path = new URL(req.url, "http://localhost").searchParams.get("path") ?? "";
      if (path === "src") {
        return {
          workspaceId: workspace.id,
          directory: "src",
          entries: [createFileEntry({
            name: "index.ts",
            path: "src/index.ts",
            kind: "file",
            size: 20,
            versionToken: "100:20",
          })],
        };
      }
      return {
        workspaceId: workspace.id,
        directory: "",
        entries: [createFileEntry()],
      };
    });

    api.get("/api/workspaces/:id/files/content", () => ({
      workspaceId: workspace.id,
      file: createFileEntry({
        name: "index.ts",
        path: "src/index.ts",
        kind: "file",
        size: 20,
        versionToken: "100:20",
      }),
      content: "export const value = 1;\n",
    }));

    const { getByRole, queryByText, user } = renderWithUser(
      <WorkspaceFilesView
        workspace={workspace}
        sessions={[]}
        createSession={async () => createSshSession()}
        onNavigate={() => {}}
      />,
    );

    await waitFor(() => {
      expect(getByRole("button", { name: /src/i })).toBeInTheDocument();
      expect(getByRole("button", { name: "Refresh explorer" })).toBeInTheDocument();
    });

    expect(queryByText("Workspace files")).not.toBeInTheDocument();

    await user.click(getByRole("button", { name: /src/i }));
    await waitFor(() => {
      expect(getByRole("button", { name: /index.ts/i })).toBeInTheDocument();
    });
    await user.click(getByRole("button", { name: /index.ts/i }));

    await waitFor(() => {
      expect(getByRole("button", { name: "Refresh file" })).toBeInTheDocument();
    });

    expect(queryByText("Editor ready")).not.toBeInTheDocument();
  });

  test("toggles hidden files from the explorer toolbar", async () => {
    installEmbeddedSshSessionMock();
    const { WorkspaceFilesView } = await import("@/components/app-shell/workspace-files-view");
    const workspace = createWorkspace({
      id: "workspace-hidden-files",
      name: "Hidden Files",
      directory: "/workspaces/hidden-files",
    });

    api.get("/api/workspaces/:id/files", (req) => {
      const url = new URL(req.url, "http://localhost");
      const path = url.searchParams.get("path") ?? "";
      const showHidden = url.searchParams.get("showHidden") === "true";

      if (path === "src") {
        return {
          workspaceId: workspace.id,
          directory: "src",
          entries: showHidden
            ? [
                createFileEntry({
                  name: ".secret.ts",
                  path: "src/.secret.ts",
                  kind: "file",
                  size: 5,
                  versionToken: "101:5",
                }),
                createFileEntry({
                  name: "index.ts",
                  path: "src/index.ts",
                  kind: "file",
                  size: 20,
                  versionToken: "100:20",
                }),
              ]
            : [createFileEntry({
                name: "index.ts",
                path: "src/index.ts",
                kind: "file",
                size: 20,
                versionToken: "100:20",
              })],
        };
      }

      return {
        workspaceId: workspace.id,
        directory: "",
        entries: [createFileEntry()],
      };
    });

    const { getByRole, queryByRole, user } = renderWithUser(
      <WorkspaceFilesView
        workspace={workspace}
        sessions={[]}
        createSession={async () => createSshSession()}
        onNavigate={() => {}}
      />,
    );

    await waitFor(() => {
      expect(getByRole("button", { name: /src/i })).toBeInTheDocument();
      expect(getByRole("button", { name: "Show hidden files" })).toBeInTheDocument();
    });

    await user.click(getByRole("button", { name: /src/i }));
    await waitFor(() => {
      expect(getByRole("button", { name: /index.ts/i })).toBeInTheDocument();
    });
    expect(queryByRole("button", { name: /\.secret\.ts/i })).not.toBeInTheDocument();

    await user.click(getByRole("button", { name: "Show hidden files" }));
    await waitFor(() => {
      expect(getByRole("button", { name: /\.secret\.ts/i })).toBeInTheDocument();
      expect(getByRole("button", { name: "Hide hidden files" })).toBeInTheDocument();
    });
  });
});
