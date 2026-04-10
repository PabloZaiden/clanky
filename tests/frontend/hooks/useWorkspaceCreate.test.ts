/**
 * Tests for useWorkspaceCreate hook.
 *
 * Covers the auto-clear behavior for completed/failed/cancelled provisioning
 * jobs when navigating to the compose/workspace view, ensuring users can
 * always create new workspaces after provisioning finishes.
 */

import { describe, test, expect, mock } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { useWorkspaceCreate } from "@/components/app-shell/use-workspace-create";
import type { UseProvisioningJobResult } from "@/hooks/useProvisioningJob";
import type { ShellRoute } from "@/components/app-shell/shell-types";
import type { ProvisioningJobSnapshot, ProvisioningJobStatus } from "@/types/provisioning";
import type { SshServer } from "@/types/ssh-server";
import type { ToastContextValue } from "@/hooks/useToast";
import type { Workspace } from "@/types/workspace";
import type { WebSocketConnectionStatus } from "@/hooks/useWebSocket";

function createMockProvisioning(overrides?: Partial<UseProvisioningJobResult>): UseProvisioningJobResult {
  return {
    activeJobId: null,
    snapshot: null,
    logs: [],
    loading: false,
    starting: false,
    error: null,
    websocketStatus: "closed" as WebSocketConnectionStatus,
    startJob: mock(() => Promise.resolve(null)),
    refreshJob: mock(() => Promise.resolve(null)),
    cancelJob: mock(() => Promise.resolve(false)),
    clearActiveJob: mock(() => {}),
    ...overrides,
  };
}

function createMockSnapshot(
  status: ProvisioningJobStatus,
  jobId = "job-1",
): ProvisioningJobSnapshot {
  return {
    job: {
      config: {
        id: jobId,
        name: "Test Workspace",
        sshServerId: "server-1",
        repoUrl: "git@github.com:test/repo.git",
        basePath: "/workspaces",
        provider: "copilot",
        createdAt: new Date().toISOString(),
      },
      state: {
        status,
        updatedAt: new Date().toISOString(),
      },
    },
    logs: [],
  };
}

function createMockToast(): ToastContextValue {
  return {
    error: mock(() => {}),
    dismiss: mock(() => {}),
    toasts: [],
  };
}

const composeWorkspaceRoute: ShellRoute = { view: "compose", kind: "workspace" };
const homeRoute: ShellRoute = { view: "home" };

interface RenderOptions {
  route?: ShellRoute;
  provisioning?: Partial<UseProvisioningJobResult>;
  servers?: SshServer[];
}

function renderUseWorkspaceCreate(options: RenderOptions = {}) {
  const provisioning = createMockProvisioning(options.provisioning);
  const toast = createMockToast();
  const navigateWithinShell = mock((_route: ShellRoute) => {});
  const createWorkspace = mock((_req: unknown) => Promise.resolve(null as Workspace | null));
  const refreshWorkspaces = mock(() => Promise.resolve());

  const hookOptions = {
    route: options.route ?? composeWorkspaceRoute,
    servers: options.servers ?? [],
    provisioning,
    createWorkspace,
    refreshWorkspaces,
    toast,
    navigateWithinShell,
  };

  const { result, rerender } = renderHook(
    (props) => useWorkspaceCreate(props),
    { initialProps: hookOptions },
  );

  return { result, rerender, provisioning, hookOptions };
}

// ─── Auto-clear terminal provisioning jobs ──────────────────────────────────

describe("useWorkspaceCreate", () => {
  describe("auto-clear completed provisioning on navigation", () => {
    test("clears completed provisioning job when navigating to compose/workspace", async () => {
      const clearActiveJob = mock(() => {});
      renderUseWorkspaceCreate({
        route: composeWorkspaceRoute,
        provisioning: {
          activeJobId: "job-1",
          snapshot: createMockSnapshot("completed"),
          clearActiveJob,
        },
      });

      await waitFor(() => {
        expect(clearActiveJob).toHaveBeenCalled();
      });
    });

    test("clears failed provisioning job when navigating to compose/workspace", async () => {
      const clearActiveJob = mock(() => {});
      renderUseWorkspaceCreate({
        route: composeWorkspaceRoute,
        provisioning: {
          activeJobId: "job-2",
          snapshot: createMockSnapshot("failed"),
          clearActiveJob,
        },
      });

      await waitFor(() => {
        expect(clearActiveJob).toHaveBeenCalled();
      });
    });

    test("clears cancelled provisioning job when navigating to compose/workspace", async () => {
      const clearActiveJob = mock(() => {});
      renderUseWorkspaceCreate({
        route: composeWorkspaceRoute,
        provisioning: {
          activeJobId: "job-3",
          snapshot: createMockSnapshot("cancelled"),
          clearActiveJob,
        },
      });

      await waitFor(() => {
        expect(clearActiveJob).toHaveBeenCalled();
      });
    });

    test("does NOT clear running provisioning job", async () => {
      const clearActiveJob = mock(() => {});
      const { result } = renderUseWorkspaceCreate({
        route: composeWorkspaceRoute,
        provisioning: {
          activeJobId: "job-4",
          snapshot: createMockSnapshot("running"),
          clearActiveJob,
        },
      });

      // Wait for the positive state change that confirms the effect ran
      await waitFor(() => {
        expect(result.current.workspaceCreateMode).toBe("automatic");
      });
      expect(clearActiveJob).not.toHaveBeenCalled();
    });

    test("does NOT clear pending provisioning job", async () => {
      const clearActiveJob = mock(() => {});
      const { result } = renderUseWorkspaceCreate({
        route: composeWorkspaceRoute,
        provisioning: {
          activeJobId: "job-5",
          snapshot: createMockSnapshot("pending"),
          clearActiveJob,
        },
      });

      // Wait for the positive state change that confirms the effect ran
      await waitFor(() => {
        expect(result.current.workspaceCreateMode).toBe("automatic");
      });
      expect(clearActiveJob).not.toHaveBeenCalled();
    });

    test("sets mode to automatic for in-progress provisioning", async () => {
      const { result } = renderUseWorkspaceCreate({
        route: composeWorkspaceRoute,
        provisioning: {
          activeJobId: "job-6",
          snapshot: createMockSnapshot("running"),
        },
      });

      await waitFor(() => {
        expect(result.current.workspaceCreateMode).toBe("automatic");
      });
    });
  });

  describe("form reset when no active provisioning", () => {
    test("resets form to manual mode when no active provisioning job", async () => {
      const { result } = renderUseWorkspaceCreate({
        route: composeWorkspaceRoute,
        provisioning: {
          activeJobId: null,
          snapshot: null,
        },
      });

      await waitFor(() => {
        expect(result.current.workspaceCreateMode).toBe("manual");
        expect(result.current.workspaceName).toBe("");
        expect(result.current.workspaceDirectory).toBe("");
      });
    });

    test("does not reset form when route is not compose/workspace", async () => {
      const clearActiveJob = mock(() => {});
      renderUseWorkspaceCreate({
        route: homeRoute,
        provisioning: {
          activeJobId: "job-7",
          snapshot: createMockSnapshot("completed"),
          clearActiveJob,
        },
      });

      // Let effects settle before asserting the negative
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(clearActiveJob).not.toHaveBeenCalled();
    });
  });
});
