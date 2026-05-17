import { describe, expect, test } from "bun:test";
import { useState, type ComponentProps, type FormEvent } from "react";
import { ComposeWorkspaceView } from "@/components/app-shell/compose-workspace-view";
import type { AgentProvider, ServerSettings } from "@/types";
import { getCreateWorkspaceDefaultServerSettings } from "@/types/settings";
import { renderWithUser, waitFor } from "../helpers/render";

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

function createProvisioningProps(): ComponentProps<typeof ComposeWorkspaceView>["provisioning"] {
  return {
    activeJobId: null,
    snapshot: null,
    logs: [],
    loading: false,
    starting: false,
    error: null,
    websocketStatus: "closed",
    startJob: async () => null,
    refreshJob: async () => null,
    cancelJob: async () => true,
    clearActiveJob: () => {},
  };
}

function noopTestConnection(_settings: ServerSettings): Promise<{ success: boolean; error?: string }> {
  return Promise.resolve({ success: true });
}

function ComposeWorkspaceViewHarness({
  initialAdvancedOpen = false,
  initialTemplate = "",
}: {
  initialAdvancedOpen?: boolean;
  initialTemplate?: string;
}) {
  const [workspaceCreateMode, setWorkspaceCreateMode] = useState<"manual" | "automatic">("automatic");
  const [workspaceName, setWorkspaceName] = useState("Workspace");
  const [workspaceDirectory, setWorkspaceDirectory] = useState("");
  const [workspaceServerSettings, setWorkspaceServerSettings] = useState<ServerSettings>(
    getCreateWorkspaceDefaultServerSettings(),
  );
  const [workspaceServerSettingsValid, setWorkspaceServerSettingsValid] = useState(true);
  const [automaticServerId, setAutomaticServerId] = useState("");
  const [automaticRepoUrl, setAutomaticRepoUrl] = useState("git@github.com:owner/repo.git");
  const [automaticCreateNewRepository, setAutomaticCreateNewRepository] = useState(false);
  const [automaticBasePath, setAutomaticBasePath] = useState("/workspaces");
  const [automaticDevcontainerSubpath, setAutomaticDevcontainerSubpath] = useState("");
  const [automaticDevboxTemplate, setAutomaticDevboxTemplate] = useState(initialTemplate);
  const [automaticAdvancedOpen, setAutomaticAdvancedOpen] = useState(initialAdvancedOpen);
  const [automaticProvider, setAutomaticProvider] = useState<AgentProvider>("copilot");
  const [automaticPassword, setAutomaticPassword] = useState("");

  return (
    <ComposeWorkspaceView
      shellHeaderOffsetClassName=""
      navigateWithinShell={() => {}}
      servers={registeredSshServers}
      workspaceCreate={{
        workspaceCreateMode,
        setWorkspaceCreateMode,
        workspaceName,
        setWorkspaceName,
        workspaceDirectory,
        setWorkspaceDirectory,
        workspaceServerSettings,
        setWorkspaceServerSettings,
        workspaceServerSettingsValid,
        setWorkspaceServerSettingsValid,
        workspaceTesting: false,
        workspaceCreateSubmitting: false,
        automaticServerId,
        setAutomaticServerId,
        automaticRepoUrl,
        setAutomaticRepoUrl,
        automaticCreateNewRepository,
        setAutomaticCreateNewRepository,
        automaticBasePath,
        setAutomaticBasePath,
        automaticDevcontainerSubpath,
        setAutomaticDevcontainerSubpath,
        automaticDevboxTemplate,
        setAutomaticDevboxTemplate,
        automaticAdvancedOpen,
        setAutomaticAdvancedOpen,
        automaticProvider,
        setAutomaticProvider,
        automaticPassword,
        setAutomaticPassword,
        handleCreateWorkspace: (event: FormEvent<HTMLFormElement>) => {
          event.preventDefault();
        },
        handleTestWorkspaceConnection: noopTestConnection,
        handleBackToAutomaticWorkspaceForm: () => {},
      }}
      provisioning={createProvisioningProps()}
      workspacesSaving={false}
      dashboardData={{ remoteOnly: false }}
    />
  );
}

describe("ComposeWorkspaceView", () => {
  test("renders a single header submit action and no cancel action while editing", async () => {
    const { getByRole, queryByRole, queryAllByText, user } = renderWithUser(<ComposeWorkspaceViewHarness />);
    const form = document.getElementById("workspace-create-form");

    expect(form).toBeTruthy();
    expect(queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(queryAllByText("Automatic")).toHaveLength(1);

    const startProvisioningButton = getByRole("button", { name: "Start Provisioning" });
    expect(startProvisioningButton).toHaveAttribute("form", "workspace-create-form");
    expect(form?.contains(startProvisioningButton)).toBe(false);

    await user.click(getByRole("button", { name: "Manual" }));

    const createWorkspaceButton = getByRole("button", { name: "Create Workspace" });
    expect(createWorkspaceButton).toHaveAttribute("form", "workspace-create-form");
    expect(form?.contains(createWorkspaceButton)).toBe(false);
  });

  test("wires advanced options disclosure semantics in automatic mode", async () => {
    const { getAllByRole, getByRole, user } = renderWithUser(<ComposeWorkspaceViewHarness />);
    const advancedButton = getByRole("button", { name: /advanced options/i });
    const panelId = advancedButton.getAttribute("aria-controls") ?? "";

    expect(panelId).not.toBe("");
    expect(advancedButton).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(panelId)).toBeNull();

    await user.click(advancedButton);

    await waitFor(() => {
      expect(advancedButton).toHaveAttribute("aria-expanded", "true");
      expect(document.getElementById(panelId)).toBeInTheDocument();
      expect(getAllByRole("textbox", { name: "Devcontainer variant" })).toHaveLength(1);
    });
  });

  test("keeps a single disabled devcontainer variant field when a template is selected", () => {
    const { getAllByRole, getByRole } = renderWithUser(
      <ComposeWorkspaceViewHarness initialAdvancedOpen={true} initialTemplate="python" />,
    );

    expect(getByRole("button", { name: /advanced options/i })).toHaveAttribute("aria-expanded", "true");
    expect(getAllByRole("textbox", { name: "Devcontainer variant" })).toHaveLength(1);
    expect(getByRole("textbox", { name: "Devcontainer variant" })).toBeDisabled();
  });
});
