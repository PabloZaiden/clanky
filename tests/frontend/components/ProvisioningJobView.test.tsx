import { describe, expect, test } from "bun:test";

import type { ProvisioningJobSnapshot } from "@/types";
import { ProvisioningJobView } from "@/components/ProvisioningJobView";
import { renderWithUser } from "../helpers/render";

function createSnapshot(
  status: ProvisioningJobSnapshot["job"]["state"]["status"],
  overrides: Partial<ProvisioningJobSnapshot["job"]["state"]> = {},
): ProvisioningJobSnapshot {
  return {
    job: {
      config: {
        id: "job-1",
        name: "Provisioned Workspace",
        sshServerId: "server-1",
        repoUrl: "git@github.com:owner/repo.git",
        basePath: "/workspaces",
        provider: "copilot",
        createdAt: new Date().toISOString(),
      },
      state: {
        status,
        currentStep: "devbox_up",
        targetDirectory: "/workspaces/repo",
        updatedAt: new Date().toISOString(),
        ...overrides,
      },
    },
    logs: [
      {
        id: "log-1",
        source: "system",
        text: "Running devbox up",
        timestamp: new Date().toISOString(),
        step: "devbox_up",
      },
    ],
  };
}

describe("ProvisioningJobView", () => {
  test("shows provisioning progress, logs, and live websocket state", () => {
    const snapshot = createSnapshot("running");

    const { getByText } = renderWithUser(
      <ProvisioningJobView
        snapshot={snapshot}
        logs={snapshot.logs}
        websocketStatus="open"
      />,
    );

    expect(getByText("Running")).toBeInTheDocument();
    expect(getByText("Live")).toBeInTheDocument();
    expect(getByText("Run devbox up")).toBeInTheDocument();
    expect(getByText("Running devbox up")).toBeInTheDocument();
  });

  test("renders errors for failed provisioning jobs", () => {
    const snapshot = createSnapshot("failed", {
      error: {
        code: "devbox_up_failed",
        message: "Failed to start devbox",
      },
    });

    const { getByText } = renderWithUser(
      <ProvisioningJobView
        snapshot={snapshot}
        logs={snapshot.logs}
        websocketStatus="error"
        error="WebSocket disconnected"
      />,
    );

    expect(getByText("Failed")).toBeInTheDocument();
    expect(getByText("Reconnecting")).toBeInTheDocument();
    expect(getByText("Failed to start devbox")).toBeInTheDocument();
    expect(getByText("WebSocket disconnected")).toBeInTheDocument();
  });

  test("renders the final workspace ready step as completed after success", () => {
    const snapshot = createSnapshot("completed", {
      currentStep: "workspace_ready",
      completedAt: new Date().toISOString(),
    });

    const { getByText } = renderWithUser(
      <ProvisioningJobView
        snapshot={snapshot}
        logs={snapshot.logs}
        websocketStatus="open"
      />,
    );

    const workspaceReadyStep = getByText("Workspace Ready");
    expect(workspaceReadyStep.className).toContain("border-green-200");
    expect(workspaceReadyStep.className).not.toContain("border-blue-300");
  });

  test("uses the restart step sequence for restart jobs", () => {
    const snapshot = createSnapshot("running");
    snapshot.job.config.mode = "restart";

    const { getByText, queryByText } = renderWithUser(
      <ProvisioningJobView
        snapshot={snapshot}
        logs={snapshot.logs}
        websocketStatus="open"
      />,
    );

    expect(getByText("Run devbox up")).toBeInTheDocument();
    expect(queryByText("Clone repository")).toBeNull();
    expect(queryByText("Rebuild devbox")).toBeNull();
  });

  test("uses the server-level arise step sequence and summary labels", () => {
    const snapshot = createSnapshot("running", {
      currentStep: "devbox_arise",
      targetDirectory: undefined,
    });
    snapshot.job.config.mode = "arise";
    snapshot.job.config.name = "Build host";
    snapshot.job.config.basePath = "/workspaces";
    snapshot.logs = [
      {
        id: "log-2",
        source: "system",
        text: "Running devbox arise",
        timestamp: new Date().toISOString(),
        step: "devbox_arise",
      },
    ];

    const { getByText, queryByText } = renderWithUser(
      <ProvisioningJobView
        snapshot={snapshot}
        logs={snapshot.logs}
        websocketStatus="open"
      />,
    );

    expect(getByText("Run devbox arise")).toBeInTheDocument();
    expect(getByText("Arise complete")).toBeInTheDocument();
    expect(getByText("Server name")).toBeInTheDocument();
    expect(getByText("Repositories base path")).toBeInTheDocument();
    expect(getByText("Build host")).toBeInTheDocument();
    expect(queryByText("Target directory")).toBeNull();
    expect(queryByText("Workspace name")).toBeNull();
  });
});
