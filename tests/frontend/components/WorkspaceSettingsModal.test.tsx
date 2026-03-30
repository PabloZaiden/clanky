/**
 * Tests for WorkspaceSettingsModal AGENTS.md optimization UI.
 *
 * Covers loading state, error + retry, and successful recovery
 * for the AGENTS.md optimization section.
 */

import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import { WorkspaceSettingsModal } from "@/components/WorkspaceSettingsModal";
import { renderWithUser, waitFor } from "../helpers/render";
import { createMockApi, MockApiError } from "../helpers/mock-api";
import { createWorkspace, createServerSettings } from "../helpers/factories";
import type { ConnectionStatus } from "@/types/settings";

const api = createMockApi();

beforeEach(() => {
  api.reset();
  api.install();
});

afterEach(() => {
  api.uninstall();
});

/** Create a workspace with server settings configured. */
function makeWorkspace(overrides?: Parameters<typeof createWorkspace>[0]) {
  return createWorkspace({
    id: "ws-test-1",
    name: "Test Workspace",
    directory: "/workspaces/test",
    serverSettings: createServerSettings({ mode: "connect" }),
    ...overrides,
  });
}

/** Default connection status (idle, not connected). */
function makeStatus(overrides?: Partial<ConnectionStatus>): ConnectionStatus {
  return {
    connected: false,
    provider: "opencode",
    transport: "stdio",
    capabilities: [],
    ...overrides,
  };
}

/** Default modal props. */
function defaultProps() {
  return {
    isOpen: true,
    onClose: mock(),
    workspace: makeWorkspace(),
    status: makeStatus(),
    onSave: mock(() => Promise.resolve(true)),
    onTest: mock(() => Promise.resolve({ success: true })),
  };
}

/** AgentsMdStatus returned by GET /api/workspaces/:id/agents-md */
function agentsMdStatus(overrides?: {
  isOptimized?: boolean;
  updateAvailable?: boolean;
  fileExists?: boolean;
}) {
  return {
    content: "# AGENTS.md content",
    fileExists: overrides?.fileExists ?? true,
    analysis: {
      isOptimized: overrides?.isOptimized ?? false,
      currentVersion: overrides?.isOptimized ? 1 : null,
      updateAvailable: overrides?.updateAvailable ?? false,
    },
  };
}

describe("WorkspaceSettingsModal AGENTS.md optimization", () => {
  describe("loading state", () => {
    test("shows loading message while fetching AGENTS.md status", async () => {
      // Register a handler that never resolves (simulating a slow connection)
      let resolveHandler!: (value: unknown) => void;
      const pendingPromise = new Promise((resolve) => {
        resolveHandler = resolve;
      });
      api.get("/api/workspaces/:id/agents-md", () => pendingPromise);

      const { getByText } = renderWithUser(
        <WorkspaceSettingsModal {...defaultProps()} />
      );

      // The loading message should appear while the fetch is pending
      await waitFor(() => {
        expect(getByText("Checking AGENTS.md status...")).toBeInTheDocument();
      });

      // Resolve to avoid dangling promise
      resolveHandler(agentsMdStatus());
    });

    test("loading message disappears after successful fetch", async () => {
      api.get("/api/workspaces/:id/agents-md", () => agentsMdStatus());

      const { getByText, queryByText } = renderWithUser(
        <WorkspaceSettingsModal {...defaultProps()} />
      );

      // Wait for the status text to appear (indicates loading is done)
      await waitFor(() => {
        expect(getByText("AGENTS.md exists but is not optimized for Ralpher.")).toBeInTheDocument();
      });

      // Loading message should be gone
      expect(queryByText("Checking AGENTS.md status...")).toBeNull();
    });
  });

  describe("error and retry", () => {
    test("shows error message when fetch fails", async () => {
      api.get("/api/workspaces/:id/agents-md", () => {
        throw new MockApiError(500, { message: "ECONNREFUSED: connection refused" });
      });

      const { getByText } = renderWithUser(
        <WorkspaceSettingsModal {...defaultProps()} />
      );

      // Should show a user-friendly error (via formatOptimizerError)
      await waitFor(() => {
        expect(getByText("Could not connect to the server. Check your connection settings and try again.")).toBeInTheDocument();
      });
    });

    test("shows Retry button when error occurs", async () => {
      api.get("/api/workspaces/:id/agents-md", () => {
        throw new MockApiError(500, { message: "Connection timed out" });
      });

      const { getByText } = renderWithUser(
        <WorkspaceSettingsModal {...defaultProps()} />
      );

      await waitFor(() => {
        expect(getByText("Retry")).toBeInTheDocument();
      });
    });

    test("does not show Optimize button when error is present", async () => {
      api.get("/api/workspaces/:id/agents-md", () => {
        throw new MockApiError(500, { message: "Server error" });
      });

      const { queryByText } = renderWithUser(
        <WorkspaceSettingsModal {...defaultProps()} />
      );

      await waitFor(() => {
        expect(queryByText("Retry")).toBeInTheDocument();
      });

      // Optimize button should not be shown when there's an error
      expect(queryByText("Optimize AGENTS.md")).not.toBeInTheDocument();
    });
  });

  describe("recovery on retry", () => {
    test("recovers from error when Retry is clicked and fetch succeeds", async () => {
      let callCount = 0;
      api.get("/api/workspaces/:id/agents-md", () => {
        callCount++;
        if (callCount === 1) {
          // First call fails
          throw new MockApiError(500, { message: "ECONNREFUSED: connection refused" });
        }
        // Second call succeeds
        return agentsMdStatus({ isOptimized: false });
      });

      const { getByText, queryByText, user } = renderWithUser(
        <WorkspaceSettingsModal {...defaultProps()} />
      );

      // Wait for the error to show
      await waitFor(() => {
        expect(getByText("Retry")).toBeInTheDocument();
      });

      // Click Retry
      await user.click(getByText("Retry"));

      // Error should clear and status should show
      await waitFor(() => {
        expect(queryByText("Could not connect to the server. Check your connection settings and try again.")).not.toBeInTheDocument();
      });

      // Now the AGENTS.md status info should appear
      await waitFor(() => {
        expect(getByText("AGENTS.md exists but is not optimized for Ralpher.")).toBeInTheDocument();
      });
    });

    test("Optimize button becomes enabled after successful retry", async () => {
      let callCount = 0;
      api.get("/api/workspaces/:id/agents-md", () => {
        callCount++;
        if (callCount === 1) {
          throw new MockApiError(500, { message: "Timeout" });
        }
        return agentsMdStatus({ isOptimized: false });
      });

      const { getByText, user } = renderWithUser(
        <WorkspaceSettingsModal {...defaultProps()} />
      );

      // Wait for error, click Retry
      await waitFor(() => {
        expect(getByText("Retry")).toBeInTheDocument();
      });
      await user.click(getByText("Retry"));

      // Wait for the Optimize button to appear and be enabled
      await waitFor(() => {
        const optimizeText = getByText("Optimize AGENTS.md");
        const button = optimizeText.closest("button")!;
        expect(button).not.toBeDisabled();
      });
    });
  });

  describe("successful status display", () => {
    test("shows 'not optimized' message when AGENTS.md exists but is not optimized", async () => {
      api.get("/api/workspaces/:id/agents-md", () => agentsMdStatus({ isOptimized: false }));

      const { getByText } = renderWithUser(
        <WorkspaceSettingsModal {...defaultProps()} />
      );

      await waitFor(() => {
        expect(getByText("AGENTS.md exists but is not optimized for Ralpher.")).toBeInTheDocument();
      });
    });

    test("shows 'no file found' message when AGENTS.md does not exist", async () => {
      api.get("/api/workspaces/:id/agents-md", () => agentsMdStatus({ fileExists: false }));

      const { getByText } = renderWithUser(
        <WorkspaceSettingsModal {...defaultProps()} />
      );

      await waitFor(() => {
        expect(getByText("No AGENTS.md file found. One will be created.")).toBeInTheDocument();
      });
    });

    test("shows Optimized badge when AGENTS.md is already optimized", async () => {
      api.get("/api/workspaces/:id/agents-md", () => agentsMdStatus({ isOptimized: true }));

      const { getByText } = renderWithUser(
        <WorkspaceSettingsModal {...defaultProps()} />
      );

      await waitFor(() => {
        expect(getByText("Optimized")).toBeInTheDocument();
      });
    });

    test("shows update available message when update is available", async () => {
      api.get("/api/workspaces/:id/agents-md", () => agentsMdStatus({ isOptimized: true, updateAvailable: true }));

      const { getByText } = renderWithUser(
        <WorkspaceSettingsModal {...defaultProps()} />
      );

      await waitFor(() => {
        expect(getByText("An updated version of the Ralpher guidelines is available.")).toBeInTheDocument();
      });
    });

    test("disables Optimize button while status is null (not yet loaded)", async () => {
      let resolveHandler!: (value: unknown) => void;
      const pendingPromise = new Promise((resolve) => {
        resolveHandler = resolve;
      });
      api.get("/api/workspaces/:id/agents-md", () => pendingPromise);

      const { getByText } = renderWithUser(
        <WorkspaceSettingsModal {...defaultProps()} />
      );

      // While loading, the loading indicator should appear
      await waitFor(() => {
        expect(getByText("Checking AGENTS.md status...")).toBeInTheDocument();
      });

      // The Optimize button is rendered but disabled because status is null
      const optimizeText = getByText("Optimize AGENTS.md");
      const button = optimizeText.closest("button")!;
      expect(button).toBeDisabled();

      resolveHandler(agentsMdStatus());
    });
  });

  describe("section visibility", () => {
    test("AGENTS.md section is shown even when not connected", async () => {
      api.get("/api/workspaces/:id/agents-md", () => agentsMdStatus());

      const { getByText } = renderWithUser(
        <WorkspaceSettingsModal
          {...defaultProps()}
          status={makeStatus({
            connected: false,
            provider: "opencode",
            transport: "stdio",
            capabilities: [],
          })}
        />
      );

      await waitFor(() => {
        expect(getByText("AGENTS.md Optimization")).toBeInTheDocument();
      });
    });

    test("AGENTS.md section is not shown when workspace is null", () => {
      const props = defaultProps();

      const { queryByText } = renderWithUser(
        <WorkspaceSettingsModal {...props} workspace={null} />
      );

      expect(queryByText("AGENTS.md Optimization")).not.toBeInTheDocument();
    });
  });
});

describe("WorkspaceSettingsModal terminal-state loop purge", () => {
  test("shows purgeable terminal-state loop count and opens confirmation modal", async () => {
    api.get("/api/workspaces/:id/agents-md", () => agentsMdStatus());

    const { getByText, user } = renderWithUser(
      <WorkspaceSettingsModal
        {...defaultProps()}
        purgeableLoopCount={3}
        onPurgeArchivedLoops={mock(() => Promise.resolve({
          success: true,
          workspaceId: "ws-test-1",
          totalArchived: 3,
          purgedCount: 3,
          purgedLoopIds: ["loop-1", "loop-2", "loop-3"],
          failures: [],
        }))}
      />
    );

    await waitFor(() => {
      expect(getByText("Loops in a Terminal State")).toBeInTheDocument();
      expect(getByText("3 purgeable")).toBeInTheDocument();
      expect(getByText("Permanently delete loops in a terminal state for this workspace once they are no longer awaiting feedback. This currently applies to merged, pushed, and deleted loops. This removes their loop data and cannot be undone.")).toBeInTheDocument();
    });

    await user.click(getByText("Purge Terminal-State Loops"));

    await waitFor(() => {
      expect(getByText('Are you sure you want to permanently delete all 3 loops in a terminal state for "Test Workspace"? This currently applies to merged, pushed, and deleted loops and cannot be undone.')).toBeInTheDocument();
    });
  });

  test("runs purge action and shows success summary", async () => {
    api.get("/api/workspaces/:id/agents-md", () => agentsMdStatus());
    const onPurgeArchivedLoops = mock(() => Promise.resolve({
      success: true,
      workspaceId: "ws-test-1",
      totalArchived: 2,
      purgedCount: 2,
      purgedLoopIds: ["loop-1", "loop-2"],
      failures: [],
    }));

    const { getByText, user } = renderWithUser(
      <WorkspaceSettingsModal
        {...defaultProps()}
        purgeableLoopCount={2}
        onPurgeArchivedLoops={onPurgeArchivedLoops}
      />
    );

    await waitFor(() => {
      expect(getByText("Purge Terminal-State Loops")).toBeInTheDocument();
    });

    await user.click(getByText("Purge Terminal-State Loops"));
    await user.click(getByText("Purge All"));

    await waitFor(() => {
      expect(onPurgeArchivedLoops).toHaveBeenCalled();
      expect(getByText("Purged 2 terminal-state loops.")).toBeInTheDocument();
    });
  });

  test("closes the confirmation modal and shows an error when purge returns failure", async () => {
    api.get("/api/workspaces/:id/agents-md", () => agentsMdStatus());
    const onPurgeArchivedLoops = mock(() => Promise.resolve({
      success: false,
      workspaceId: "ws-test-1",
      totalArchived: 2,
      purgedCount: 0,
      purgedLoopIds: [],
      failures: [],
    }));

    const { getByText, queryByText, user } = renderWithUser(
      <WorkspaceSettingsModal
        {...defaultProps()}
        purgeableLoopCount={2}
        onPurgeArchivedLoops={onPurgeArchivedLoops}
      />
    );

    await waitFor(() => {
      expect(getByText("Purge Terminal-State Loops")).toBeInTheDocument();
    });

    await user.click(getByText("Purge Terminal-State Loops"));
    await user.click(getByText("Purge All"));

    await waitFor(() => {
      expect(onPurgeArchivedLoops).toHaveBeenCalled();
      expect(queryByText('Are you sure you want to permanently delete all 2 loops in a terminal state for "Test Workspace"? This currently applies to merged, pushed, and deleted loops and cannot be undone.')).not.toBeInTheDocument();
      expect(getByText("Failed to purge terminal-state loops.")).toBeInTheDocument();
    });
  });

  test("closes the confirmation modal and shows thrown purge errors", async () => {
    api.get("/api/workspaces/:id/agents-md", () => agentsMdStatus());
    const onPurgeArchivedLoops = mock(() => Promise.reject(new Error("Remote cleanup failed")));

    const { getByText, queryByText, user } = renderWithUser(
      <WorkspaceSettingsModal
        {...defaultProps()}
        purgeableLoopCount={2}
        onPurgeArchivedLoops={onPurgeArchivedLoops}
      />
    );

    await waitFor(() => {
      expect(getByText("Purge Terminal-State Loops")).toBeInTheDocument();
    });

    await user.click(getByText("Purge Terminal-State Loops"));
    await user.click(getByText("Purge All"));

    await waitFor(() => {
      expect(onPurgeArchivedLoops).toHaveBeenCalled();
      expect(queryByText('Are you sure you want to permanently delete all 2 loops in a terminal state for "Test Workspace"? This currently applies to merged, pushed, and deleted loops and cannot be undone.')).not.toBeInTheDocument();
      expect(getByText("Failed to purge terminal-state loops: Error: Remote cleanup failed")).toBeInTheDocument();
    });
  });

  test("disables purge button when there are no purgeable terminal-state loops", async () => {
    api.get("/api/workspaces/:id/agents-md", () => agentsMdStatus());

    const { getByText } = renderWithUser(
      <WorkspaceSettingsModal
        {...defaultProps()}
        purgeableLoopCount={0}
        onPurgeArchivedLoops={mock(() => Promise.resolve({
          success: true,
          workspaceId: "ws-test-1",
          totalArchived: 0,
          purgedCount: 0,
          purgedLoopIds: [],
          failures: [],
        }))}
      />
    );

    await waitFor(() => {
      const purgeButton = getByText("Purge Terminal-State Loops").closest("button");
      expect(purgeButton).toBeDisabled();
    });
  });
});

describe("WorkspaceSettingsModal workspace deletion", () => {
  test("disables workspace deletion while loops still exist", async () => {
    api.get("/api/workspaces/:id/agents-md", () => agentsMdStatus());

    const { getByRole, getByText } = renderWithUser(
      <WorkspaceSettingsModal
        {...defaultProps()}
        onDeleteWorkspace={mock(() => Promise.resolve({ success: true }))}
        workspaceLoopCount={2}
      />
    );

      await waitFor(() => {
        expect(getByRole("button", { name: "Delete Workspace" })).toBeDisabled();
        expect(
          getByText("Delete the remaining 2 loops in this workspace before removing it from Ralpher. This only removes the workspace record and does not delete files on disk.")
        ).toBeInTheDocument();
      });
    });

  test("opens a confirmation modal and closes on successful delete", async () => {
    api.get("/api/workspaces/:id/agents-md", () => agentsMdStatus());
    const onClose = mock();
    const onDeleteWorkspace = mock(() => Promise.resolve({ success: true }));

    const { getByRole, getByText, user } = renderWithUser(
      <WorkspaceSettingsModal
        {...defaultProps()}
        onClose={onClose}
        onDeleteWorkspace={onDeleteWorkspace}
      />
    );

    await waitFor(() => {
      expect(getByRole("button", { name: "Delete Workspace" })).toBeInTheDocument();
    });

    await user.click(getByRole("button", { name: "Delete Workspace" }));

    await waitFor(() => {
      expect(
        getByText('Are you sure you want to delete workspace "Test Workspace"? This only removes it from Ralpher and does not delete files on disk.')
      ).toBeInTheDocument();
    });

    await user.click(getByText("Delete"));

    await waitFor(() => {
      expect(onDeleteWorkspace).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
      expect(getByText('Deleted workspace "Test Workspace"')).toBeInTheDocument();
    });
  });

  test("shows the delete failure and keeps the modal open when deletion is rejected", async () => {
    api.get("/api/workspaces/:id/agents-md", () => agentsMdStatus());
    const onClose = mock();
    const onDeleteWorkspace = mock(() => Promise.resolve({
      success: false,
      error: "Workspace has 1 loop(s). Delete all loops first.",
    }));

    const { getByRole, getByText, queryByText, user } = renderWithUser(
      <WorkspaceSettingsModal
        {...defaultProps()}
        onClose={onClose}
        onDeleteWorkspace={onDeleteWorkspace}
      />
    );

    await waitFor(() => {
      expect(getByRole("button", { name: "Delete Workspace" })).toBeInTheDocument();
    });

    await user.click(getByRole("button", { name: "Delete Workspace" }));
    await user.click(getByText("Delete"));

    await waitFor(() => {
      expect(onDeleteWorkspace).toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(queryByText('Are you sure you want to delete workspace "Test Workspace"? This only removes it from Ralpher and does not delete files on disk.')).not.toBeInTheDocument();
      expect(getByText("Workspace has 1 loop(s). Delete all loops first.")).toBeInTheDocument();
    });
  });
});
