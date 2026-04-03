/**
 * Tests for the WorkspaceSelector component.
 */

import { test, expect, describe } from "bun:test";
import { mock } from "bun:test";
import { WorkspaceSelector } from "@/components/WorkspaceSelector";
import { renderWithUser } from "../helpers/render";
import { createWorkspace } from "../helpers/factories";
import type { SshServer } from "@/types";

describe("WorkspaceSelector", () => {
  describe("rendering", () => {
    test("renders workspace label with required asterisk", () => {
      const { getByText } = renderWithUser(
        <WorkspaceSelector workspaces={[]} onSelect={mock()} />
      );
      expect(getByText("Workspace")).toBeInTheDocument();
      expect(getByText("*")).toBeInTheDocument();
    });

    test("renders select element", () => {
      const { getByRole } = renderWithUser(
        <WorkspaceSelector workspaces={[]} onSelect={mock()} />
      );
      expect(getByRole("combobox")).toBeInTheDocument();
    });

    test("renders default placeholder option", () => {
      const workspaces = [createWorkspace({ name: "My Project" })];
      const { getByRole } = renderWithUser(
        <WorkspaceSelector workspaces={workspaces} onSelect={mock()} />
      );
      const select = getByRole("combobox") as HTMLSelectElement;
      expect(select.options[0]?.text).toBe("Select a workspace...");
    });
  });

  describe("workspace options", () => {
    test("renders workspace options with server labels by default", () => {
      const workspaces = [
        createWorkspace({ name: "Project A" }),
        createWorkspace({
          name: "Project B",
          serverSettings: {
            agent: {
              provider: "opencode",
              transport: "ssh",
              hostname: "remote.example",
              port: 2222,
            },
          },
        }),
      ];
      const { getByRole } = renderWithUser(
        <WorkspaceSelector workspaces={workspaces} onSelect={mock()} />
      );
      const select = getByRole("combobox") as HTMLSelectElement;
      const optionTexts = Array.from(select.options).map((option) => option.text);
      expect(optionTexts.some((text) => text.includes("Project A"))).toBe(true);
      expect(optionTexts.some((text) => text.includes("Project B"))).toBe(true);
      expect(optionTexts.some((text) => text.includes("remote.example"))).toBe(true);
    });

    test("renders workspace names only when server details are hidden", () => {
      const workspaces = [
        createWorkspace({ name: "Project A" }),
        createWorkspace({
          name: "Project B",
          serverSettings: {
            agent: {
              provider: "opencode",
              transport: "ssh",
              hostname: "remote.example",
              port: 2222,
            },
          },
        }),
      ];
      const { getByRole } = renderWithUser(
        <WorkspaceSelector
          workspaces={workspaces}
          onSelect={mock()}
          showServerDetails={false}
        />
      );
      const select = getByRole("combobox") as HTMLSelectElement;
      const optionTexts = Array.from(select.options).map((option) => option.text);

      expect(optionTexts).toContain("Project A");
      expect(optionTexts).toContain("Project B");
      expect(optionTexts.some((text) => text.includes("remote.example"))).toBe(false);
    });

    test("keeps the selected workspace in the dropdown without extra detail text", () => {
      const workspace = createWorkspace({
        id: "ws-1",
        name: "My Workspace",
        directory: "/home/user/project",
        serverSettings: {
          agent: {
            provider: "opencode",
            transport: "ssh",
            hostname: "selected.example",
            port: 2200,
          },
        },
      });
      const { getByRole, queryByText } = renderWithUser(
        <WorkspaceSelector
          workspaces={[workspace]}
          selectedWorkspaceId="ws-1"
          onSelect={mock()}
        />
      );
      const select = getByRole("combobox") as HTMLSelectElement;
      expect(select.value).toBe("ws-1");
      expect(Array.from(select.options).some((option) => option.text.includes("selected.example"))).toBe(true);
      expect(queryByText("/home/user/project")).not.toBeInTheDocument();
    });

    test("shows registered SSH server name in the dropdown option when available", () => {
      const workspace = createWorkspace({
        id: "ws-registered",
        name: "Registered Workspace",
        directory: "/home/user/registered-project",
        serverSettings: {
          agent: {
            provider: "opencode",
            transport: "ssh",
            hostname: "10.0.0.42",
            port: 22,
            username: "deploy",
          },
        },
      });
      const registeredSshServers: SshServer[] = [{
        config: {
          id: "ssh-server-1",
          name: "Production Box",
          address: "10.0.0.42",
          username: "deploy",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
        publicKey: {
          algorithm: "RSA-OAEP-256",
          publicKey: "public-key",
          fingerprint: "fingerprint",
          version: 1,
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      }];

      const { getByRole, queryByText } = renderWithUser(
        <WorkspaceSelector
          workspaces={[workspace]}
          selectedWorkspaceId={workspace.id}
          registeredSshServers={registeredSshServers}
          onSelect={mock()}
        />
      );
      const select = getByRole("combobox") as HTMLSelectElement;
      const optionTexts = Array.from(select.options).map((option) => option.text);

      expect(optionTexts.some((text) => text.includes("Production Box"))).toBe(true);
      expect(optionTexts.some((text) => text.includes("deploy@10.0.0.42:22"))).toBe(false);
      expect(queryByText("/home/user/registered-project")).not.toBeInTheDocument();
    });

    test("does not show directory when no workspace selected", () => {
      const workspace = createWorkspace({
        directory: "/home/user/project",
      });
      const { queryByText } = renderWithUser(
        <WorkspaceSelector workspaces={[workspace]} onSelect={mock()} />
      );
      expect(queryByText("/home/user/project")).not.toBeInTheDocument();
    });
  });

  describe("loading state", () => {
    test("shows loading text when loading", () => {
      const { getByRole } = renderWithUser(
        <WorkspaceSelector workspaces={[]} loading={true} onSelect={mock()} />
      );
      const select = getByRole("combobox") as HTMLSelectElement;
      expect(select.options[0]?.text).toBe("Loading workspaces...");
    });

    test("disables select when loading", () => {
      const { getByRole } = renderWithUser(
        <WorkspaceSelector workspaces={[]} loading={true} onSelect={mock()} />
      );
      expect(getByRole("combobox")).toBeDisabled();
    });
  });

  describe("empty state", () => {
    test("shows no workspaces text when empty and not loading", () => {
      const { getByRole } = renderWithUser(
        <WorkspaceSelector workspaces={[]} onSelect={mock()} />
      );
      const select = getByRole("combobox") as HTMLSelectElement;
      expect(select.options[0]?.text).toBe("No workspaces available");
    });

    test("disables select when no workspaces", () => {
      const { getByRole } = renderWithUser(
        <WorkspaceSelector workspaces={[]} onSelect={mock()} />
      );
      expect(getByRole("combobox")).toBeDisabled();
    });

    test("shows create workspace hint when no workspaces", () => {
      const { getByText } = renderWithUser(
        <WorkspaceSelector workspaces={[]} onSelect={mock()} />
      );
      expect(getByText("Create a workspace from the dashboard first.")).toBeInTheDocument();
    });
  });

  describe("error state", () => {
    test("renders error message when error provided", () => {
      const { getByText } = renderWithUser(
        <WorkspaceSelector
          workspaces={[]}
          onSelect={mock()}
          error="Failed to load workspaces"
        />
      );
      expect(getByText("Failed to load workspaces")).toBeInTheDocument();
    });

    test("does not render error when no error", () => {
      const { queryByText } = renderWithUser(
        <WorkspaceSelector workspaces={[]} onSelect={mock()} />
      );
      // No red error text should exist
      expect(queryByText("Failed to load")).not.toBeInTheDocument();
    });

    test("does not render error when error is null", () => {
      const { container } = renderWithUser(
        <WorkspaceSelector workspaces={[]} onSelect={mock()} error={null} />
      );
      const errorEl = container.querySelector(".text-red-600");
      expect(errorEl).not.toBeInTheDocument();
    });
  });

  describe("selection interaction", () => {
    test("calls onSelect with workspace id and directory on selection", async () => {
      const onSelect = mock();
      const workspace = createWorkspace({
        id: "ws-1",
        name: "Project A",
        directory: "/home/user/project-a",
      });
      const { getByRole, user } = renderWithUser(
        <WorkspaceSelector workspaces={[workspace]} onSelect={onSelect} />
      );
      const select = getByRole("combobox") as HTMLSelectElement;
      await user.selectOptions(select, "ws-1");
      expect(onSelect).toHaveBeenCalledWith("ws-1", "/home/user/project-a");
    });

    test("calls onSelect with null when deselecting", async () => {
      const onSelect = mock();
      const workspace = createWorkspace({
        id: "ws-1",
        name: "Project A",
      });
      const { getByRole, user } = renderWithUser(
        <WorkspaceSelector
          workspaces={[workspace]}
          selectedWorkspaceId="ws-1"
          onSelect={onSelect}
        />
      );
      const select = getByRole("combobox") as HTMLSelectElement;
      await user.selectOptions(select, "");
      expect(onSelect).toHaveBeenCalledWith(null, "");
    });
  });
});
