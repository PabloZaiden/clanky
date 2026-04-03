import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createMockApi } from "../helpers/mock-api";
import { renderWithUser, waitFor } from "../helpers/render";
import { createLoopWithStatus, createSshSession, createWorkspace } from "../helpers/factories";

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

describe("LoopFilesView", () => {
  beforeEach(() => {
    api.reset();
    api.install();
  });

  afterEach(() => {
    api.uninstall();
    mock.restore();
  });

  test("creates or reuses the loop SSH session when opening a terminal", async () => {
    installEmbeddedSshSessionMock();
    const { LoopFilesView } = await import("@/components/app-shell/loop-files-view");
    const workspace = createWorkspace({
      id: "workspace-loop-files",
      name: "Loop Workspace",
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
    const loop = createLoopWithStatus("running", {
      config: {
        id: "loop-ssh-1",
        name: "Loop SSH",
        workspaceId: workspace.id,
        directory: workspace.directory,
        useWorktree: true,
      },
      state: {
        git: {
          originalBranch: "main",
          workingBranch: "loop-ssh-route",
          commits: [],
          worktreePath: "/workspaces/loop-files/.ralph-worktrees/loop-ssh-1",
        },
      },
    });
    const loopSession = createSshSession({
      config: {
        id: "loop-session-1",
        workspaceId: workspace.id,
        loopId: loop.config.id,
        name: "Loop SSH Session",
      },
    });

    api.get("/api/workspaces/:id/files", () => ({
      workspaceId: workspace.id,
      directory: "",
      entries: [],
    }));
    api.post("/api/loops/:id/ssh-session", () => loopSession);

    const { getByRole, getByText, user } = renderWithUser(
      <LoopFilesView
        loop={loop}
        workspace={workspace}
        sessions={[]}
        onNavigate={() => {}}
      />,
    );

    await waitFor(() => {
      expect(getByRole("button", { name: "Terminals" })).toBeInTheDocument();
    });

    await user.click(getByRole("button", { name: "Terminals" }));
    await user.click(getByRole("button", { name: /New terminal/i }));

    await waitFor(() => {
      expect(api.calls("/api/loops/:id/ssh-session", "POST")).toHaveLength(1);
      expect(getByText("Embedded SSH session: loop-session-1 (focused)")).toBeInTheDocument();
    });
  });

  test("keeps long loop terminal names shrink-safe in the explorer header", async () => {
    installEmbeddedSshSessionMock();
    const { LoopFilesView } = await import("@/components/app-shell/loop-files-view");
    const workspace = createWorkspace({
      id: "workspace-loop-files-long-name",
      name: "Loop Workspace",
      directory: "/workspaces/loop-files-long-name",
      serverSettings: {
        agent: {
          provider: "opencode",
          transport: "ssh",
          hostname: "remote.example",
          username: "tester",
        },
      },
    });
    const loop = createLoopWithStatus("running", {
      config: {
        id: "loop-ssh-long-name",
        name: "Loop SSH",
        workspaceId: workspace.id,
        directory: workspace.directory,
        useWorktree: true,
      },
      state: {
        git: {
          originalBranch: "main",
          workingBranch: "loop-ssh-route",
          commits: [],
          worktreePath: "/workspaces/loop-files-long-name/.ralph-worktrees/loop-ssh-long-name",
        },
      },
    });
    const longSessionName = "Show only workspace names in loop creation worktrees terminal session";
    const loopSession = createSshSession({
      config: {
        id: "loop-session-long-name",
        workspaceId: workspace.id,
        loopId: loop.config.id,
        name: longSessionName,
      },
    });

    api.get("/api/workspaces/:id/files", () => ({
      workspaceId: workspace.id,
      directory: "",
      entries: [],
    }));

    const { getByRole, getByTestId, user } = renderWithUser(
      <LoopFilesView
        loop={loop}
        workspace={workspace}
        sessions={[loopSession]}
        onNavigate={() => {}}
      />,
    );

    await waitFor(() => {
      expect(getByRole("button", { name: "Terminals" })).toBeInTheDocument();
    });

    await user.click(getByRole("button", { name: "Terminals" }));

    const terminalControls = getByTestId("workspace-terminal-controls");
    const terminalSelect = getByTestId("workspace-terminal-select");

    expect(terminalControls).toHaveClass("flex-col");
    expect(terminalControls).toHaveClass("md:flex-row");
    expect(terminalSelect).toHaveAttribute("title", longSessionName);
    expect(terminalSelect).toHaveClass("w-full");
    expect(terminalSelect).toHaveClass("max-w-full");
  });
});
