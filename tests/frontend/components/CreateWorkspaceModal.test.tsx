import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ProvisioningJobSnapshot } from "@/types";
import { CreateWorkspaceModal } from "@/components/CreateWorkspaceModal";
import { createMockApi } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { act, renderWithUser, waitFor } from "../helpers/render";

const api = createMockApi();
const ws = createMockWebSocket();

const registeredSshServers = [
  {
    config: {
      id: "server-1",
      name: "Build Box",
      address: "10.0.0.5",
      username: "vscode",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    publicKey: {
      algorithm: "RSA-OAEP-256" as const,
      publicKey: "public-key-1",
      fingerprint: "fingerprint-1",
      version: 1,
      createdAt: new Date().toISOString(),
    },
  },
];

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
        currentStep: "clone_repo",
        updatedAt: new Date().toISOString(),
        ...overrides,
      },
    },
    logs: [
      {
        id: "log-1",
        source: "system",
        text: "Created workspace Provisioned Workspace",
        timestamp: new Date().toISOString(),
        step: "create_workspace",
      },
    ],
    ...(status === "completed"
      ? {
          workspace: {
            id: "workspace-1",
            name: "Provisioned Workspace",
            directory: "/workspaces/repo",
            serverSettings: {
              agent: {
                provider: "copilot",
                transport: "ssh",
                hostname: "10.0.0.5",
                port: 2222,
                username: "vscode",
                password: "secret",
              },
            },
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }
      : {}),
  };
}

describe("CreateWorkspaceModal", () => {
  beforeEach(() => {
    api.reset();
    api.install();
    ws.reset();
    ws.install();
  });

  afterEach(() => {
    api.uninstall();
    ws.uninstall();
  });

  test("submits automatic provisioning requests from the automatic tab", async () => {
    const startedSnapshot = createSnapshot("running");
    api.post("/api/provisioning-jobs", () => startedSnapshot);
    api.get("/api/provisioning-jobs/:id", () => startedSnapshot);

    const onCreate = mock(async () => true);

    const { getByLabelText, getByRole, queryByLabelText, user } = renderWithUser(
      <CreateWorkspaceModal
        isOpen={true}
        onClose={() => {}}
        onCreate={onCreate}
        registeredSshServers={registeredSshServers}
      />,
    );

    await user.click(getByRole("button", { name: "Automatic" }));

    expect(queryByLabelText("Directory *")).not.toBeInTheDocument();

    await user.type(getByLabelText("Workspace Name *"), "Provisioned Workspace");
    await user.type(getByLabelText("Git Repository URL *"), "git@github.com:owner/repo.git");
    await user.clear(getByLabelText("Remote Base Path *"));
    await user.type(getByLabelText("Remote Base Path *"), "/srv/workspaces");

    await user.click(getByRole("button", { name: "Start Provisioning" }));

    await waitFor(() => {
      expect(api.calls("/api/provisioning-jobs", "POST")).toHaveLength(1);
      expect(ws.getConnections("/api/ws")).toHaveLength(1);
    });

    expect(onCreate).not.toHaveBeenCalled();
    expect(api.calls("/api/provisioning-jobs", "POST")[0]?.body).toEqual({
      name: "Provisioned Workspace",
      sshServerId: "server-1",
      repoUrl: "git@github.com:owner/repo.git",
      basePath: "/srv/workspaces",
      provider: "copilot",
    });
    expect(ws.getConnections("/api/ws")[0]?.queryParams["provisioningJobId"]).toBe("job-1");
  });

  test("hides the password field when a stored browser credential exists", async () => {
    window.localStorage.setItem(
      "ralpher.sshServerCredential.server-1",
      JSON.stringify({
        encryptedCredential: {
          algorithm: "RSA-OAEP-256",
          fingerprint: "fingerprint-1",
          version: 1,
          ciphertext: "ciphertext",
        },
        storedAt: new Date().toISOString(),
      }),
    );

    const { getByRole, queryByLabelText, user } = renderWithUser(
      <CreateWorkspaceModal
        isOpen={true}
        onClose={() => {}}
        onCreate={mock(async () => true)}
        registeredSshServers={registeredSshServers}
      />,
    );

    await user.click(getByRole("button", { name: "Automatic" }));

    expect(queryByLabelText("SSH Password")).not.toBeInTheDocument();
  });

  test("renders observer mode and only refreshes once for a completed provisioning job", async () => {
    const completedSnapshot = createSnapshot("completed");
    const firstRefresh = mock(async () => {});
    const secondRefresh = mock(async () => {});
    const onClose = mock(() => {});

    window.localStorage.setItem("ralpher.activeProvisioningJobId", "job-1");
    api.get("/api/provisioning-jobs/:id", () => completedSnapshot);

    const { getAllByRole, getByText, rerender, user } = renderWithUser(
      <CreateWorkspaceModal
        isOpen={true}
        onClose={onClose}
        onCreate={mock(async () => true)}
        registeredSshServers={registeredSshServers}
        onProvisioningSuccess={firstRefresh}
      />,
    );

    await waitFor(() => {
      expect(getByText("Provisioning log")).toBeInTheDocument();
      expect(firstRefresh).toHaveBeenCalledTimes(1);
    });

    rerender(
      <CreateWorkspaceModal
        isOpen={true}
        onClose={onClose}
        onCreate={mock(async () => true)}
        registeredSshServers={registeredSshServers}
        onProvisioningSuccess={secondRefresh}
      />,
    );

    await waitFor(() => {
      expect(secondRefresh).not.toHaveBeenCalled();
    });

    await user.click(getAllByRole("button", { name: "Close" }).at(-1)!);
    expect(window.localStorage.getItem("ralpher.activeProvisioningJobId")).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test("returns to the automatic form after failure with the previous configuration prefilled", async () => {
    const failedSnapshot = createSnapshot("failed", {
      error: {
        code: "clone_failed",
        message: "Failed to clone repository",
      },
    });
    const retriedSnapshot = createSnapshot("running");

    window.localStorage.setItem("ralpher.activeProvisioningJobId", "job-1");
    api.get("/api/provisioning-jobs/:id", () => failedSnapshot);
    api.post("/api/provisioning-jobs", () => retriedSnapshot);

    const { getByRole, getByText, user } = renderWithUser(
      <CreateWorkspaceModal
        isOpen={true}
        onClose={() => {}}
        onCreate={mock(async () => true)}
        registeredSshServers={registeredSshServers}
      />,
    );

    await waitFor(() => {
      expect(getByText("Failed to clone repository")).toBeInTheDocument();
      expect(getByRole("button", { name: "Back" })).toBeInTheDocument();
    });

    await user.click(getByRole("button", { name: "Back" }));

    await waitFor(() => {
      expect(getByRole("button", { name: "Start Provisioning" })).toBeInTheDocument();
    });

    expect(window.localStorage.getItem("ralpher.activeProvisioningJobId")).toBeNull();
    expect((getByRole("textbox", { name: "Workspace Name *" }) as HTMLInputElement).value).toBe("Provisioned Workspace");
    expect((getByRole("textbox", { name: "Git Repository URL *" }) as HTMLInputElement).value).toBe("git@github.com:owner/repo.git");
    expect((getByRole("textbox", { name: "Remote Base Path *" }) as HTMLInputElement).value).toBe("/workspaces");

    await user.clear(getByRole("textbox", { name: "Remote Base Path *" }));
    await user.type(getByRole("textbox", { name: "Remote Base Path *" }), "/srv/workspaces");
    await user.click(getByRole("button", { name: "Start Provisioning" }));

    await waitFor(() => {
      expect(api.calls("/api/provisioning-jobs", "POST")).toHaveLength(1);
    });

    expect(api.calls("/api/provisioning-jobs", "POST")[0]?.body).toEqual({
      name: "Provisioned Workspace",
      sshServerId: "server-1",
      repoUrl: "git@github.com:owner/repo.git",
      basePath: "/srv/workspaces",
      provider: "copilot",
    });
  });

  test("preserves user-entered form values after a live submission fails and Back is clicked", async () => {
    const startedSnapshot = createSnapshot("running");
    const failedSnapshot = createSnapshot("failed", {
      error: {
        code: "clone_failed",
        message: "Clone failed",
      },
    });
    let requestCount = 0;

    api.post("/api/provisioning-jobs", () => {
      // Return running snapshot, then simulate failure on the next GET
      return startedSnapshot;
    });
    api.get("/api/provisioning-jobs/:id", () => {
      requestCount += 1;
      return requestCount === 1 ? startedSnapshot : failedSnapshot;
    });

    const { getByLabelText, getByRole, getByText, user } = renderWithUser(
      <CreateWorkspaceModal
        isOpen={true}
        onClose={() => {}}
        onCreate={mock(async () => true)}
        registeredSshServers={registeredSshServers}
      />,
    );

    // Switch to Automatic tab and fill in values
    await user.click(getByRole("button", { name: "Automatic" }));
    await user.type(getByLabelText("Workspace Name *"), "My Test Workspace");
    await user.type(getByLabelText("Git Repository URL *"), "git@github.com:test/project.git");
    await user.clear(getByLabelText("Remote Base Path *"));
    await user.type(getByLabelText("Remote Base Path *"), "/custom/path");

    // Submit
    await user.click(getByRole("button", { name: "Start Provisioning" }));

    await waitFor(() => {
      expect(api.calls("/api/provisioning-jobs", "POST")).toHaveLength(1);
    });

    // Wait for the job to show as failed (polling picks it up)
    await waitFor(() => {
      expect(getByText("Clone failed")).toBeInTheDocument();
      expect(getByRole("button", { name: "Back" })).toBeInTheDocument();
    }, { timeout: 3000 });

    // Click Back
    await user.click(getByRole("button", { name: "Back" }));

    // Form should be back with the exact values the user entered
    await waitFor(() => {
      expect(getByRole("button", { name: "Start Provisioning" })).toBeInTheDocument();
    });

    expect((getByRole("textbox", { name: "Workspace Name *" }) as HTMLInputElement).value).toBe("My Test Workspace");
    expect((getByRole("textbox", { name: "Git Repository URL *" }) as HTMLInputElement).value).toBe("git@github.com:test/project.git");
    expect((getByRole("textbox", { name: "Remote Base Path *" }) as HTMLInputElement).value).toBe("/custom/path");
    // Password is intentionally empty after going back (security)
    expect(window.localStorage.getItem("ralpher.activeProvisioningJobId")).toBeNull();
  });

  test("shows Back after a live provisioning failure even if the terminal websocket event is missed", async () => {
    const runningSnapshot = createSnapshot("running");
    const failedSnapshot = createSnapshot("failed", {
      error: {
        code: "clone_failed",
        message: "Failed to clone repository",
      },
    });
    let requestCount = 0;

    window.localStorage.setItem("ralpher.activeProvisioningJobId", "job-1");
    api.get("/api/provisioning-jobs/:id", () => {
      requestCount += 1;
      return requestCount === 1 ? runningSnapshot : failedSnapshot;
    });

    const { getByRole, getByText } = renderWithUser(
      <CreateWorkspaceModal
        isOpen={true}
        onClose={() => {}}
        onCreate={mock(async () => true)}
        registeredSshServers={registeredSshServers}
      />,
    );

    await waitFor(() => {
      expect(getByText("Provisioning log")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(getByText("Failed to clone repository")).toBeInTheDocument();
      expect(getByRole("button", { name: "Back" })).toBeInTheDocument();
    }, { timeout: 2000 });
  });

  test("turns the final workspace ready step green after a live success log triggers completion refresh", async () => {
    const runningSnapshot = createSnapshot("running", {
      currentStep: "test_connection",
    });
    const completedSnapshotBase = createSnapshot("completed", {
      currentStep: "workspace_ready",
      completedAt: new Date().toISOString(),
    });
    const successLog = {
      id: "log-success",
      source: "system" as const,
      text: "Workspace connection test succeeded. Workspace Provisioned Workspace was created successfully and is ready.",
      timestamp: new Date().toISOString(),
      step: "workspace_ready" as const,
    };
    const completedSnapshot = {
      ...completedSnapshotBase,
      logs: [
        ...completedSnapshotBase.logs,
        successLog,
      ],
    };
    let requestCount = 0;

    window.localStorage.setItem("ralpher.activeProvisioningJobId", "job-1");
    api.get("/api/provisioning-jobs/:id", () => {
      requestCount += 1;
      return requestCount === 1 ? runningSnapshot : completedSnapshot;
    });

    const { getByText } = renderWithUser(
      <CreateWorkspaceModal
        isOpen={true}
        onClose={() => {}}
        onCreate={mock(async () => true)}
        registeredSshServers={registeredSshServers}
      />,
    );

    await waitFor(() => {
      expect(getByText("Workspace Ready")).toBeInTheDocument();
    });

    const provisioningConnection = ws.getConnections("/api/ws")[0];
    if (!provisioningConnection) {
      throw new Error("Expected provisioning websocket connection");
    }

    act(() => {
      ws.sendEventTo(provisioningConnection, {
        type: "provisioning.output",
        provisioningJobId: "job-1",
        entry: successLog,
        timestamp: successLog.timestamp,
      });
    });

    await waitFor(() => {
      expect(getByText(successLog.text)).toBeInTheDocument();
      expect(getByText("Workspace Ready").className).toContain("border-green-200");
    });
  });
});
