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
      repositoriesBasePath: null,
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

const defaultTemplates = [
  {
    name: "python",
    description: "Python 3.14 on Debian bookworm.",
    source: "built-in" as const,
    base: "bookworm",
    image: "mcr.microsoft.com/devcontainers/python:3.0.7-3.14-bookworm",
    pinnedReference: "mcr.microsoft.com/devcontainers/python:3.0.7-3.14-bookworm",
    runtimeVersion: "Python 3.14",
    languages: ["python"],
    runnerCompatible: true,
  },
  {
    name: "bun",
    description: "Official Bun image on Debian trixie.",
    source: "built-in" as const,
    base: "trixie",
    image: "oven/bun:1.3.13",
    pinnedReference: "oven/bun:1.3.13",
    runtimeVersion: "Bun 1.3.13",
    languages: ["bun", "javascript", "typescript"],
    runnerCompatible: true,
  },
];

function getAdvancedOptionsButton(): HTMLButtonElement {
  const advanced = Array.from(document.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes("Advanced options"),
  );
  if (!(advanced instanceof HTMLButtonElement)) {
    throw new Error("Expected advanced options button");
  }
  return advanced;
}

function getAutomaticDevcontainerVariantInput(): HTMLInputElement {
  const input = document.getElementById("automatic-devcontainer-subpath");
  if (!(input instanceof HTMLInputElement)) {
    throw new Error("Expected automatic devcontainer variant input");
  }
  return input;
}

function getAutomaticDevboxTemplateSelect(): HTMLSelectElement {
  const input = document.getElementById("automatic-devbox-template");
  if (!(input instanceof HTMLSelectElement)) {
    throw new Error("Expected automatic devbox template select");
  }
  return input;
}

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
    api.post("/api/ssh-servers/:id/devbox/templates", () => defaultTemplates, 200);
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
    await user.click(getAdvancedOptionsButton());
    await user.type(getAutomaticDevcontainerVariantInput(), ".devcontainer/backend/devcontainer.json");

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
      devcontainerSubpath: ".devcontainer/backend/devcontainer.json",
      devboxTemplate: null,
      provider: "copilot",
      credentialToken: null,
      mode: "provision",
      targetDirectory: null,
      workspaceId: null,
    });
    expect(ws.getConnections("/api/ws")[0]?.queryParams["provisioningJobId"]).toBe("job-1");
  });

  test("wires accessible disclosure semantics for automatic advanced options", async () => {
    const { getByRole, user } = renderWithUser(
      <CreateWorkspaceModal
        isOpen={true}
        onClose={() => {}}
        onCreate={mock(async () => true)}
        registeredSshServers={registeredSshServers}
      />,
    );

    await user.click(getByRole("button", { name: "Automatic" }));

    const advancedButton = getAdvancedOptionsButton();
    const panelId = advancedButton.getAttribute("aria-controls") ?? "";

    expect(panelId).not.toBe("");
    expect(advancedButton).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(panelId)).toBeNull();

    await user.click(advancedButton);

    await waitFor(() => {
      expect(advancedButton).toHaveAttribute("aria-expanded", "true");
      expect(document.getElementById(panelId)).toBeInTheDocument();
    });
  });

  test("submits an automatic provisioning request with a selected devbox template", async () => {
    const startedSnapshot = {
      ...createSnapshot("running"),
      job: {
        ...createSnapshot("running").job,
        config: {
          ...createSnapshot("running").job.config,
          devboxTemplate: "python",
        },
      },
    };
    api.post("/api/provisioning-jobs", () => startedSnapshot);
    api.get("/api/provisioning-jobs/:id", () => startedSnapshot);

    const { getByLabelText, getByRole, user } = renderWithUser(
      <CreateWorkspaceModal
        isOpen={true}
        onClose={() => {}}
        onCreate={mock(async () => true)}
        registeredSshServers={registeredSshServers}
      />,
    );

    await user.click(getByRole("button", { name: "Automatic" }));
    await user.type(getByLabelText("Workspace Name *"), "Template Workspace");
    await user.type(getByLabelText("Git Repository URL *"), "git@github.com:owner/repo.git");
    await user.click(getAdvancedOptionsButton());
    await user.selectOptions(getAutomaticDevboxTemplateSelect(), "python");

    expect(getAutomaticDevcontainerVariantInput()).toBeDisabled();

    await user.click(getByRole("button", { name: "Start Provisioning" }));

    await waitFor(() => {
      expect(api.calls("/api/provisioning-jobs", "POST")).toHaveLength(1);
    });

    expect(api.calls("/api/provisioning-jobs", "POST")[0]?.body).toEqual({
      name: "Template Workspace",
      sshServerId: "server-1",
      repoUrl: "git@github.com:owner/repo.git",
      basePath: "/workspaces",
      devcontainerSubpath: null,
      devboxTemplate: "python",
      provider: "copilot",
      credentialToken: null,
      mode: "provision",
      targetDirectory: null,
      workspaceId: null,
    });
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
    const startedSnapshot = createSnapshot("running");
    const completedSnapshot = createSnapshot("completed");
    const firstRefresh = mock(async () => {});
    const secondRefresh = mock(async () => {});
    const onClose = mock(() => {});

    api.post("/api/provisioning-jobs", () => startedSnapshot);
    api.get("/api/provisioning-jobs/:id", () => completedSnapshot);

    const { getAllByRole, getByText, getByLabelText, getByRole, rerender, user } = renderWithUser(
      <CreateWorkspaceModal
        isOpen={true}
        onClose={onClose}
        onCreate={mock(async () => true)}
        registeredSshServers={registeredSshServers}
        onProvisioningSuccess={firstRefresh}
      />,
    );

    await user.click(getByRole("button", { name: "Automatic" }));
    await user.type(getByLabelText("Workspace Name *"), "Provisioned Workspace");
    await user.type(getByLabelText("Git Repository URL *"), "git@github.com:owner/repo.git");
    await user.click(getAdvancedOptionsButton());
    await user.type(getAutomaticDevcontainerVariantInput(), ".devcontainer/backend/devcontainer.json");
    await user.click(getByRole("button", { name: "Start Provisioning" }));

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
    const startedSnapshot = {
      ...createSnapshot("running"),
      job: {
        ...createSnapshot("running").job,
        config: {
          ...createSnapshot("running").job.config,
          devcontainerSubpath: ".devcontainer/backend/devcontainer.json",
        },
      },
    };
    const failedSnapshot = {
      ...createSnapshot("failed", {
        error: {
          code: "clone_failed",
          message: "Failed to clone repository",
        },
      }),
      job: {
        ...createSnapshot("failed", {
          error: {
            code: "clone_failed",
            message: "Failed to clone repository",
          },
        }).job,
        config: {
          ...createSnapshot("failed", {
            error: {
              code: "clone_failed",
              message: "Failed to clone repository",
            },
          }).job.config,
          devcontainerSubpath: ".devcontainer/backend/devcontainer.json",
        },
      },
    };

    api.post("/api/provisioning-jobs", () => startedSnapshot);
    api.get("/api/provisioning-jobs/:id", () => failedSnapshot);

    const { getByRole, getByLabelText, getByText, user } = renderWithUser(
      <CreateWorkspaceModal
        isOpen={true}
        onClose={() => {}}
        onCreate={mock(async () => true)}
        registeredSshServers={registeredSshServers}
      />,
    );

    await user.click(getByRole("button", { name: "Automatic" }));
    await user.type(getByLabelText("Workspace Name *"), "Provisioned Workspace");
    await user.type(getByLabelText("Git Repository URL *"), "git@github.com:owner/repo.git");
    await user.click(getByRole("button", { name: "Start Provisioning" }));

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
    expect(getAutomaticDevcontainerVariantInput().value).toBe(".devcontainer/backend/devcontainer.json");

    await user.clear(getByRole("textbox", { name: "Remote Base Path *" }));
    await user.type(getByRole("textbox", { name: "Remote Base Path *" }), "/srv/workspaces");
    await user.click(getByRole("button", { name: "Start Provisioning" }));

    await waitFor(() => {
      expect(api.calls("/api/provisioning-jobs", "POST")).toHaveLength(2);
    });

    expect(api.calls("/api/provisioning-jobs", "POST")[1]?.body).toEqual({
      name: "Provisioned Workspace",
      sshServerId: "server-1",
      repoUrl: "git@github.com:owner/repo.git",
      basePath: "/srv/workspaces",
      devcontainerSubpath: ".devcontainer/backend/devcontainer.json",
      devboxTemplate: null,
      provider: "copilot",
      credentialToken: null,
      mode: "provision",
      targetDirectory: null,
      workspaceId: null,
    });
  });

  test("preserves user-entered form values after a live submission fails and Back is clicked", async () => {
    // Snapshots reflect the values the user actually submitted (as a real API would).
    const startedSnapshot: ProvisioningJobSnapshot = {
      job: {
        config: {
          id: "job-user-values",
          name: "My Test Workspace",
          sshServerId: "server-1",
          repoUrl: "git@github.com:test/project.git",
          basePath: "/custom/path",
          devcontainerSubpath: ".devcontainer/backend/devcontainer.json",
          provider: "copilot",
          createdAt: new Date().toISOString(),
        },
        state: {
          status: "running",
          currentStep: "clone_repo",
          updatedAt: new Date().toISOString(),
        },
      },
      logs: [],
    };
    const failedSnapshot: ProvisioningJobSnapshot = {
      ...startedSnapshot,
      job: {
        ...startedSnapshot.job,
        state: {
          status: "failed",
          currentStep: "clone_repo",
          updatedAt: new Date().toISOString(),
          error: { code: "clone_failed", message: "Clone failed" },
        },
      },
    };
    let requestCount = 0;

    api.post("/api/provisioning-jobs", () => {
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
    await user.click(getAdvancedOptionsButton());
    await user.type(getAutomaticDevcontainerVariantInput(), ".devcontainer/backend/devcontainer.json");

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
    expect(getAutomaticDevcontainerVariantInput().value).toBe(".devcontainer/backend/devcontainer.json");
    // Password is intentionally empty after going back (security)
    expect(window.localStorage.getItem("ralpher.activeProvisioningJobId")).toBeNull();
  });

  test("preserves a selected devbox template after failure and Back", async () => {
    const startedSnapshot: ProvisioningJobSnapshot = {
      job: {
        config: {
          id: "job-template-values",
          name: "Template Workspace",
          sshServerId: "server-1",
          repoUrl: "git@github.com:test/project.git",
          basePath: "/workspaces",
          devboxTemplate: "python",
          provider: "copilot",
          createdAt: new Date().toISOString(),
        },
        state: {
          status: "running",
          currentStep: "clone_repo",
          updatedAt: new Date().toISOString(),
        },
      },
      logs: [],
    };
    const failedSnapshot: ProvisioningJobSnapshot = {
      ...startedSnapshot,
      job: {
        ...startedSnapshot.job,
        state: {
          status: "failed",
          currentStep: "clone_repo",
          updatedAt: new Date().toISOString(),
          error: { code: "clone_failed", message: "Clone failed" },
        },
      },
    };
    let requestCount = 0;

    api.post("/api/provisioning-jobs", () => startedSnapshot);
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

    await user.click(getByRole("button", { name: "Automatic" }));
    await user.type(getByLabelText("Workspace Name *"), "Template Workspace");
    await user.type(getByLabelText("Git Repository URL *"), "git@github.com:test/project.git");
    await user.click(getAdvancedOptionsButton());
    await user.selectOptions(getAutomaticDevboxTemplateSelect(), "python");

    await user.click(getByRole("button", { name: "Start Provisioning" }));

    await waitFor(() => {
      expect(getByText("Clone failed")).toBeInTheDocument();
      expect(getByRole("button", { name: "Back" })).toBeInTheDocument();
    }, { timeout: 3000 });

    await user.click(getByRole("button", { name: "Back" }));

    await waitFor(() => {
      expect(getByRole("button", { name: "Start Provisioning" })).toBeInTheDocument();
    });

    expect(getAutomaticDevboxTemplateSelect().value).toBe("python");
    expect(getAutomaticDevcontainerVariantInput()).toBeDisabled();
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

    api.post("/api/provisioning-jobs", () => runningSnapshot);
    api.get("/api/provisioning-jobs/:id", () => {
      requestCount += 1;
      return requestCount === 1 ? runningSnapshot : failedSnapshot;
    });

    const { getByRole, getByLabelText, getByText, user } = renderWithUser(
      <CreateWorkspaceModal
        isOpen={true}
        onClose={() => {}}
        onCreate={mock(async () => true)}
        registeredSshServers={registeredSshServers}
      />,
    );

    await user.click(getByRole("button", { name: "Automatic" }));
    await user.type(getByLabelText("Workspace Name *"), "Provisioned Workspace");
    await user.type(getByLabelText("Git Repository URL *"), "git@github.com:owner/repo.git");
    await user.click(getByRole("button", { name: "Start Provisioning" }));

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

    api.post("/api/provisioning-jobs", () => runningSnapshot);
    api.get("/api/provisioning-jobs/:id", () => {
      requestCount += 1;
      return requestCount === 1 ? runningSnapshot : completedSnapshot;
    });

    const { getByText, getByRole, getByLabelText, user } = renderWithUser(
      <CreateWorkspaceModal
        isOpen={true}
        onClose={() => {}}
        onCreate={mock(async () => true)}
        registeredSshServers={registeredSshServers}
      />,
    );

    await user.click(getByRole("button", { name: "Automatic" }));
    await user.type(getByLabelText("Workspace Name *"), "Provisioned Workspace");
    await user.type(getByLabelText("Git Repository URL *"), "git@github.com:owner/repo.git");
    await user.click(getByRole("button", { name: "Start Provisioning" }));

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
