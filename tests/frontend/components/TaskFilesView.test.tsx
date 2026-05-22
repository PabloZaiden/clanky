import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ComponentProps } from "react";
import { createMockApi } from "../helpers/mock-api";
import { renderWithUser, waitFor } from "../helpers/render";
import { createTaskWithStatus, createSshSession, createWorkspace } from "../helpers/factories";
import { ThemePreferenceProvider } from "@/hooks";

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

function EmbeddedSshSessionStub({
  sshSessionId,
  forcedFocusMode,
}: {
  sshSessionId: string;
  forcedFocusMode?: boolean;
}) {
  return (
    <div>
      Embedded SSH session: {sshSessionId}
      {forcedFocusMode ? " (focused)" : ""}
    </div>
  );
}

async function loadTaskFilesView() {
  const { TaskFilesView } = await import("@/components/app-shell/task-files-view");

  return function TaskFilesViewWithStub(
    props: Omit<ComponentProps<typeof TaskFilesView>, "sshSessionDetailsComponent">,
  ) {
    return (
      <ThemePreferenceProvider>
        <TaskFilesView {...props} sshSessionDetailsComponent={EmbeddedSshSessionStub} />
      </ThemePreferenceProvider>
    );
  };
}

describe("TaskFilesView", () => {
  beforeEach(() => {
    api.reset();
    api.install();
  });

  afterEach(() => {
    api.uninstall();
    mock.restore();
  });

  test("creates or reuses the task SSH session when opening a terminal", async () => {
    const TaskFilesView = await loadTaskFilesView();
    const workspace = createWorkspace({
      id: "workspace-task-files",
      name: "Task Workspace",
      directory: "/workspaces/task-files",
      serverSettings: {
        agent: {
          provider: "opencode",
          transport: "ssh",
          hostname: "remote.example",
          username: "tester",
        },
      },
    });
    const task = createTaskWithStatus("running", {
      config: {
        id: "task-ssh-1",
        name: "Task SSH",
        workspaceId: workspace.id,
        directory: workspace.directory,
        useWorktree: true,
      },
      state: {
        git: {
          originalBranch: "main",
          workingBranch: "task-ssh-route",
          commits: [],
          worktreePath: "/workspaces/task-files/.clanky-worktrees/task-ssh-1",
        },
      },
    });
    const taskSession = createSshSession({
      config: {
        id: "task-session-1",
        workspaceId: workspace.id,
        taskId: task.config.id,
        name: "Task SSH Session",
      },
    });

    api.get("/api/workspaces/:id/files", () => ({
      workspaceId: workspace.id,
      directory: "",
      entries: [],
    }));
    api.post("/api/tasks/:id/ssh-session", () => taskSession);

    const { getByRole, getByText, user } = renderWithUser(
      <TaskFilesView
        task={task}
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
      expect(api.calls("/api/tasks/:id/ssh-session", "POST")).toHaveLength(1);
      expect(getByText("Embedded SSH session: task-session-1 (focused)")).toBeInTheDocument();
    });
  });

  test("keeps long task terminal names shrink-safe in the explorer header", async () => {
    const TaskFilesView = await loadTaskFilesView();
    const workspace = createWorkspace({
      id: "workspace-task-files-long-name",
      name: "Task Workspace",
      directory: "/workspaces/task-files-long-name",
      serverSettings: {
        agent: {
          provider: "opencode",
          transport: "ssh",
          hostname: "remote.example",
          username: "tester",
        },
      },
    });
    const task = createTaskWithStatus("running", {
      config: {
        id: "task-ssh-long-name",
        name: "Task SSH",
        workspaceId: workspace.id,
        directory: workspace.directory,
        useWorktree: true,
      },
      state: {
        git: {
          originalBranch: "main",
          workingBranch: "task-ssh-route",
          commits: [],
          worktreePath: "/workspaces/task-files-long-name/.clanky-worktrees/task-ssh-long-name",
        },
      },
    });
    const longSessionName = "Show only workspace names in task creation worktrees terminal session";
    const taskSession = createSshSession({
      config: {
        id: "task-session-long-name",
        workspaceId: workspace.id,
        taskId: task.config.id,
        name: longSessionName,
      },
    });

    api.get("/api/workspaces/:id/files", () => ({
      workspaceId: workspace.id,
      directory: "",
      entries: [],
    }));

    const { getByRole, getByTestId, user } = renderWithUser(
      <TaskFilesView
        task={task}
        workspace={workspace}
        sessions={[taskSession]}
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
