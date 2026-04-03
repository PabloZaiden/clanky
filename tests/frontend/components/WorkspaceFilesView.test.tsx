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

function createTreeResponse(
  entriesByDirectory: Record<string, ReturnType<typeof createFileEntry>[]>,
) {
  return { entriesByDirectory };
}

describe("WorkspaceFilesView", () => {
  beforeEach(() => {
    api.reset();
    api.install();
    api.get("/api/preferences/file-explorer-full-tree", () => ({ enabled: true }));
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

    api.get("/api/workspaces/:id/files/tree", () => ({
      workspaceId: workspace.id,
      ...createTreeResponse({
        "": [createFileEntry()],
        src: [createFileEntry({
          name: "index.ts",
          path: "src/index.ts",
          kind: "file",
          size: 20,
          versionToken: "100:20",
        })],
      }),
    }));

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

    api.get("/api/workspaces/:id/files/tree", () => ({
      workspaceId: workspace.id,
      ...createTreeResponse({
        "": [],
      }),
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

  test("constrains long terminal names in the shared selector layout", async () => {
    installEmbeddedSshSessionMock();
    const { WorkspaceFilesView } = await import("@/components/app-shell/workspace-files-view");
    const workspace = createWorkspace({
      id: "workspace-ssh-long-name",
      name: "Long SSH Workspace",
      directory: "/workspaces/ssh-long-name",
      serverSettings: {
        agent: {
          provider: "opencode",
          transport: "ssh",
          hostname: "remote.example",
          username: "tester",
        },
      },
    });
    const longSessionName = "Show only workspace names in loop creation worktrees terminal session";
    const session = createSshSession({
      config: {
        id: "session-long-name",
        workspaceId: workspace.id,
        name: longSessionName,
      },
    });

    api.get("/api/workspaces/:id/files/tree", () => ({
      workspaceId: workspace.id,
      ...createTreeResponse({
        "": [],
      }),
    }));

    const { getByRole, getByTestId, user } = renderWithUser(
      <WorkspaceFilesView
        workspace={workspace}
        sessions={[session]}
        createSession={async () => createSshSession()}
        onNavigate={() => {}}
      />,
    );

    await user.click(getByRole("button", { name: "Terminals" }));
    await waitFor(() => {
      expect(getByRole("combobox", { name: "Select workspace SSH session" })).toBeInTheDocument();
    });

    const terminalControls = getByTestId("workspace-terminal-controls");
    const terminalSelect = getByTestId("workspace-terminal-select");

    expect(terminalControls).toHaveClass("flex-col");
    expect(terminalControls).toHaveClass("md:flex-row");
    expect(terminalSelect).toHaveClass("w-full");
    expect(terminalSelect).toHaveClass("max-w-full");
    expect(terminalSelect).toHaveClass("md:w-[20rem]");
    expect(terminalSelect).toHaveClass("lg:w-[24rem]");
    expect(terminalSelect).toHaveAttribute("title", longSessionName);
  });

  test("can collapse and expand the file explorer pane", async () => {
    installEmbeddedSshSessionMock();
    const { WorkspaceFilesView } = await import("@/components/app-shell/workspace-files-view");
    const workspace = createWorkspace({
      id: "workspace-collapse",
      name: "Explorer Collapse",
      directory: "/workspaces/explorer-collapse",
    });

    api.get("/api/workspaces/:id/files/tree", () => ({
      workspaceId: workspace.id,
      ...createTreeResponse({
        "": [createFileEntry()],
        src: [],
      }),
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

    api.get("/api/workspaces/:id/files/tree", () => ({
      workspaceId: workspace.id,
      ...createTreeResponse({
        "": [createFileEntry()],
        src: [],
      }),
    }));

    const { getByRole, getByTestId, queryByRole, user } = renderWithUser(
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

    const explorerColumn = getByTestId("workspace-explorer-column");
    const paneSwitcher = getByTestId("workspace-pane-switcher");
    const header = getByTestId("workspace-file-tree-header");

    expect(explorerColumn).toHaveClass("max-h-[35vh]");
    expect(explorerColumn).toHaveClass("overflow-hidden");
    expect(paneSwitcher).toHaveClass("grid");
    expect(paneSwitcher).not.toHaveClass("lg:flex");
    expect(header).not.toHaveClass("lg:h-full");

    await user.click(getByRole("button", { name: "Collapse file explorer" }));

    expect(queryByRole("button", { name: /src/i })).not.toBeInTheDocument();
    expect(getByRole("button", { name: "Expand file explorer" })).toBeInTheDocument();
    expect(getByRole("button", { name: "Files" })).toBeInTheDocument();
    expect(getByRole("button", { name: "Terminals" })).toBeInTheDocument();
    expect(explorerColumn).toHaveClass("max-h-none");
    expect(explorerColumn).toHaveClass("overflow-visible");
    expect(explorerColumn).not.toHaveClass("max-h-[35vh]");
    expect(paneSwitcher).toHaveClass("grid");
    expect(paneSwitcher).toHaveClass("lg:flex");
    expect(header).toHaveClass("lg:h-full");
    expect(header).toHaveClass("justify-between");

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

    api.get("/api/workspaces/:id/files/tree", () => ({
      workspaceId: workspace.id,
      ...createTreeResponse({
        "": [createFileEntry()],
        src: [createFileEntry({
          name: "index.ts",
          path: "src/index.ts",
          kind: "file",
          size: 20,
          versionToken: "100:20",
        })],
      }),
    }));

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

    api.get("/api/workspaces/:id/files/tree", () => ({
      workspaceId: workspace.id,
      ...createTreeResponse({
        "": [
          createFileEntry(),
          createFileEntry({
            name: ".env",
            path: ".env",
            kind: "file",
            size: 10,
            versionToken: "99:10",
          }),
        ],
        src: [
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
        ],
      }),
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
      expect(getByRole("button", { name: "Hide hidden files" })).toBeInTheDocument();
      expect(getByRole("button", { name: /\.env/i })).toBeInTheDocument();
    });

    await user.click(getByRole("button", { name: /src/i }));
    await waitFor(() => {
      expect(getByRole("button", { name: /\.secret\.ts/i })).toBeInTheDocument();
      expect(getByRole("button", { name: /index.ts/i })).toBeInTheDocument();
    });
    expect(api.calls("/api/workspaces/:id/files/tree", "GET")).toHaveLength(1);

    await user.click(getByRole("button", { name: "Hide hidden files" }));
    await waitFor(() => {
      expect(queryByRole("button", { name: /\.env/i })).not.toBeInTheDocument();
      expect(queryByRole("button", { name: /\.secret\.ts/i })).not.toBeInTheDocument();
      expect(getByRole("button", { name: "Show hidden files" })).toBeInTheDocument();
    });
    expect(api.calls("/api/workspaces/:id/files/tree", "GET")).toHaveLength(1);
  });

  test("opens the shared root picker on demand, shows the mode checkbox, and saves mode changes", async () => {
    installEmbeddedSshSessionMock();
    const { WorkspaceFilesView } = await import("@/components/app-shell/workspace-files-view");
    const workspace = createWorkspace({
      id: "workspace-root-picker",
      name: "Root Picker",
      directory: "/workspaces/root-picker",
    });
    const onNavigate = mock(() => {});

    api.get("/api/workspaces/:id/files/tree", () => ({
      workspaceId: workspace.id,
      ...createTreeResponse({
        "": [],
      }),
    }));
    api.put("/api/preferences/file-explorer-full-tree", () => ({ success: true }), 200);

    const { getByLabelText, getByRole, queryByLabelText, user } = renderWithUser(
      <WorkspaceFilesView
        workspace={workspace}
        sessions={[]}
        createSession={async () => createSshSession()}
        onNavigate={onNavigate}
      />,
    );

    await waitFor(() => {
      expect(getByRole("button", { name: "Change explorer root" })).toBeInTheDocument();
    });
    expect(queryByLabelText("Explorer root directory")).not.toBeInTheDocument();

    await user.click(getByRole("button", { name: "Change explorer root" }));

    await waitFor(() => {
      expect(getByLabelText("Explorer root directory")).toHaveValue("/workspaces/root-picker");
      const fullTreeCheckbox = getByRole("checkbox", { name: /Load everything at once/i });
      expect(fullTreeCheckbox).toBeChecked();
      expect(fullTreeCheckbox.getAttribute("aria-describedby")).toEndWith("-load-full-tree-description");
    });

    await user.click(getByRole("checkbox", { name: /Load everything at once/i }));
    await user.click(getByRole("button", { name: "Apply changes" }));

    await waitFor(() => {
      expect(api.calls("/api/preferences/file-explorer-full-tree", "PUT")).toHaveLength(1);
    });

    expect(onNavigate).not.toHaveBeenCalled();
    expect(queryByLabelText("Explorer root directory")).not.toBeInTheDocument();
  });

  test("navigates to a custom explorer root from the shared root picker", async () => {
    installEmbeddedSshSessionMock();
    const { WorkspaceFilesView } = await import("@/components/app-shell/workspace-files-view");
    const workspace = createWorkspace({
      id: "workspace-root-picker-nav",
      name: "Root Picker",
      directory: "/workspaces/root-picker",
    });
    const onNavigate = mock(() => {});

    api.get("/api/workspaces/:id/files/tree", () => ({
      workspaceId: workspace.id,
      ...createTreeResponse({
        "": [],
      }),
    }));

    const { getByLabelText, getByRole, queryByLabelText, user } = renderWithUser(
      <WorkspaceFilesView
        workspace={workspace}
        sessions={[]}
        createSession={async () => createSshSession()}
        onNavigate={onNavigate}
      />,
    );

    await waitFor(() => {
      expect(getByRole("button", { name: "Change explorer root" })).toBeInTheDocument();
    });
    expect(queryByLabelText("Explorer root directory")).not.toBeInTheDocument();

    await user.click(getByRole("button", { name: "Change explorer root" }));

    await waitFor(() => {
      expect(getByLabelText("Explorer root directory")).toHaveValue("/workspaces/root-picker");
    });

    await user.clear(getByLabelText("Explorer root directory"));
    await user.type(getByLabelText("Explorer root directory"), "/var/tmp/project");
    await user.click(getByRole("button", { name: "Apply changes" }));

    expect(onNavigate).toHaveBeenCalledWith({
      view: "workspace-files",
      workspaceId: workspace.id,
      startDirectory: "/var/tmp/project",
    });
  });

  test("resets explorer tree state when the start directory changes", async () => {
    installEmbeddedSshSessionMock();
    const { WorkspaceFilesView } = await import("@/components/app-shell/workspace-files-view");
    const workspace = createWorkspace({
      id: "workspace-root-sync",
      name: "Root Sync",
      directory: "/workspaces/root-sync",
    });

    api.get("/api/workspaces/:id/files/tree", (req) => {
      const url = new URL(req.url, "http://localhost");
      const startDirectory = url.searchParams.get("startDirectory") ?? "";

      if (startDirectory === "/alt/root") {
        return {
          workspaceId: workspace.id,
          ...createTreeResponse({
            "": [createFileEntry({
              name: "packages",
              path: "packages",
              kind: "directory",
            })],
            packages: [],
          }),
        };
      }

      return {
        workspaceId: workspace.id,
        ...createTreeResponse({
          "": [createFileEntry({
            name: "src",
            path: "src",
            kind: "directory",
          })],
          src: [],
        }),
      };
    });

    const { getByRole, queryByRole, rerender } = renderWithUser(
      <WorkspaceFilesView
        workspace={workspace}
        sessions={[]}
        startDirectory={workspace.directory}
        createSession={async () => createSshSession()}
        onNavigate={() => {}}
      />,
    );

    await waitFor(() => {
      expect(getByRole("button", { name: /src/i })).toBeInTheDocument();
    });

    rerender(
      <WorkspaceFilesView
        workspace={workspace}
        sessions={[]}
        startDirectory="/alt/root"
        createSession={async () => createSshSession()}
        onNavigate={() => {}}
      />,
    );

    await waitFor(() => {
      expect(getByRole("button", { name: /packages/i })).toBeInTheDocument();
    });
    expect(queryByRole("button", { name: /src/i })).not.toBeInTheDocument();
  });
});
