/**
 * Tests for LoopDetails component.
 *
 * Tests loop data display, tab navigation, planning mode, action buttons,
 * modal flows, connection status, loading/error states, and the action bar.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createMockApi, MockApiError } from "../helpers/mock-api";
import { createMockWebSocket } from "../helpers/mock-websocket";
import { renderWithUser, waitFor, within } from "../helpers/render";
import {
  createLoopWithStatus,
  createFileDiff,
  createSshSession,
  createPersistedMessage,
  createPersistedToolCall,
} from "../helpers/factories";
import { LoopDetails } from "@/components/LoopDetails";
import { loopDetailsTabPaddingClassName } from "@/components/loop-details/tab-layout";

const api = createMockApi();
const ws = createMockWebSocket();

const LOOP_ID = "loop-1";
let openCalls: Array<{ url: string; target: string; features: string }> = [];
let originalWindowOpen: typeof window.open;

/** Set up default API routes for LoopDetails. */
function setupDefaultApi(loopOverrides?: Parameters<typeof createLoopWithStatus>[1]) {
  const loop = createLoopWithStatus("running", {
    config: { id: LOOP_ID, name: "Test Loop", prompt: "Fix the bug", ...(loopOverrides?.config ?? {}) },
    state: loopOverrides?.state,
  });

  // Core loop endpoint
  api.get("/api/loops/:id", () => loop);
  // Diff, plan, status-file
  api.get("/api/loops/:id/diff", () => []);
  api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
  api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
  api.get("/api/loops/:id/pull-request", () => ({
    enabled: false,
    destinationType: "disabled",
    disabledReason: "GitHub CLI is not available in the loop environment.",
  }));
  // Comments
  api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
  // Models
  api.get("/api/models", () => []);
  // Preferences
  api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
  api.get("/api/preferences/log-level", () => ({ level: "info" }));
  // Actions (POST/PUT/DELETE)
  api.post("/api/loops/:id/accept", () => ({ success: true, mergeCommit: "abc123" }));
  api.post("/api/loops/:id/push", () => ({ success: true }));
  api.post("/api/loops/:id/stop", () => ({ success: true }));
  api.delete("/api/loops/:id", () => ({ success: true }));
  api.post("/api/loops/:id/purge", () => ({ success: true }));
  api.post("/api/loops/:id/mark-merged", () => ({ success: true }));
  api.post("/api/loops/:id/manual-complete", () => ({ success: true }));
  api.post("/api/loops/:id/address-comments", () => ({ success: true }));
  api.post("/api/loops/:id/automatic-pr-flow/start", () => ({
    success: true,
    automaticPrFlow: {
      enabled: true,
      status: "monitoring",
      startedAt: "2026-04-11T04:00:00.000Z",
      updatedAt: "2026-04-11T04:00:00.000Z",
      lastCheckedAt: "2026-04-11T04:00:00.000Z",
      pullRequestNumber: 1,
      pullRequestUrl: "https://github.com/example/repo/pull/1",
    },
  }));
  api.post("/api/loops/:id/automatic-pr-flow/stop", () => ({
    success: true,
    automaticPrFlow: {
      enabled: false,
      status: "stopped",
      startedAt: "2026-04-11T04:00:00.000Z",
      updatedAt: "2026-04-11T04:10:00.000Z",
      stoppedAt: "2026-04-11T04:10:00.000Z",
    },
  }));
  api.post("/api/loops/:id/pending", () => ({ success: true }));
  api.post("/api/loops/:id/follow-up", () => ({ success: true }));
  api.delete("/api/loops/:id/pending", () => ({ success: true }));
  api.put("/api/loops/:id", () => loop);
  api.patch("/api/loops/:id", () => loop);
  api.post("/api/loops/:id/plan/feedback", () => ({ success: true }));
  api.post("/api/loops/:id/plan/accept", () => ({ success: true, mode: "start_loop" }), 200);
  api.post("/api/loops/:id/plan/discard", () => ({ success: true }));

  return loop;
}

beforeEach(() => {
  api.reset();
  api.install();
  api.get("/api/loops/:id/port-forwards", () => []);
  ws.reset();
  ws.install();
  openCalls = [];
  originalWindowOpen = window.open;
  window.open = ((url?: string | URL, target?: string, features?: string) => {
    openCalls.push({
      url: String(url),
      target: target ?? "",
      features: features ?? "",
    });
    return null;
  }) as typeof window.open;
});

afterEach(() => {
  window.open = originalWindowOpen;
  api.uninstall();
  ws.uninstall();
});

// ─── Loading state ───────────────────────────────────────────────────────────

describe("loading state", () => {
  test("shows loading spinner while fetching loop", async () => {
    // Return a never-resolving promise so we stay in loading
    let resolveLoop!: (loop: ReturnType<typeof createLoopWithStatus>) => void;
    const pendingPromise = new Promise<ReturnType<typeof createLoopWithStatus>>((resolve) => {
      resolveLoop = resolve;
    });
    api.get("/api/loops/:id", () => pendingPromise as unknown as ReturnType<typeof createLoopWithStatus>);
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { container } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    // The loading state shows an animate-spin element
    const spinner = container.querySelector(".animate-spin");
    expect(spinner).toBeTruthy();

    // Clean up
    resolveLoop(createLoopWithStatus("running", { config: { id: LOOP_ID } }));
  });
});

// ─── Loop not found ──────────────────────────────────────────────────────────

describe("loop not found", () => {
  test("shows loop not found when API returns error", async () => {
    api.get("/api/loops/:id", () => {
      throw new MockApiError(404, { error: "not_found" });
    });
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Not found")).toBeTruthy();
    });
    // The error detail is shown in the paragraph below
    expect(getByText("Loop not found")).toBeTruthy();
  });

  test("shows back button in not found state", async () => {
    api.get("/api/loops/:id", () => {
      throw new MockApiError(404, { error: "not_found" });
    });
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const onBack = () => {};
    const { getByText } = renderWithUser(
      <LoopDetails loopId={LOOP_ID} onBack={onBack} />,
    );

    await waitFor(() => {
      expect(getByText("Not found")).toBeTruthy();
    });

    // Back button should also be present
    const backBtn = document.querySelector('button');
    expect(backBtn?.textContent).toContain("Back");
  });
});

// ─── Header display ──────────────────────────────────────────────────────────

describe("header display", () => {
  test("renders loop name in header", async () => {
    setupDefaultApi();
    const { getByText } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Test Loop")).toBeTruthy();
    });
  });

  test("renders status badge", async () => {
    setupDefaultApi();
    const { getByText } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Running")).toBeTruthy();
    });
  });

  test("renders back button", async () => {
    setupDefaultApi();
    const onBack = () => {};
    const { getByRole } = renderWithUser(
      <LoopDetails loopId={LOOP_ID} onBack={onBack} />,
    );

    await waitFor(() => {
      expect(getByRole("button", { name: /Back/ })).toBeTruthy();
    });
  });

  test("calls onBack when back button is clicked", async () => {
    setupDefaultApi();
    let backCalled = false;
    const onBack = () => { backCalled = true; };
    const { getByRole, user } = renderWithUser(
      <LoopDetails loopId={LOOP_ID} onBack={onBack} />,
    );

    await waitFor(() => {
      expect(getByRole("button", { name: /Back/ })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: /Back/ }));
    expect(backCalled).toBe(true);
  });

  test("hides the back button when embedded in the shell", async () => {
    setupDefaultApi();
    const { queryByRole } = renderWithUser(
      <LoopDetails loopId={LOOP_ID} showBackButton={false} />,
    );

    await waitFor(() => {
      expect(queryByRole("button", { name: /Back/ })).toBeNull();
    });
  });

  test("renders rename button", async () => {
    setupDefaultApi();
    const { container } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      const renameBtn = container.querySelector('button[aria-label="Rename loop"]');
      expect(renameBtn).toBeTruthy();
    });
  });

  test("does not show active indicator for completed loops", async () => {
    const loop = createLoopWithStatus("completed", {
      config: { id: LOOP_ID, name: "Done Loop" },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, container } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Done Loop")).toBeTruthy();
    });

    const pinger = container.querySelector(".animate-ping");
    expect(pinger).toBeNull();
  });

});

// ─── Connection status ───────────────────────────────────────────────────────

describe("connection status", () => {
  test("does not show a Live connection label in the header", async () => {
    setupDefaultApi();
    const { getByText } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Test Loop")).toBeTruthy();
    });
  });
});

// ─── Tab navigation ──────────────────────────────────────────────────────────

describe("tab navigation", () => {
  test("renders all tab labels", async () => {
    setupDefaultApi();
    const { getByText } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Test Loop")).toBeTruthy();
    });

    // All tabs should be visible
    for (const tabLabel of ["Log", "Info", "Prompt", "Plan", "Diff", "Actions"]) {
      expect(getByText(tabLabel)).toBeTruthy();
    }
  });

  test("Log tab is active by default", async () => {
    setupDefaultApi();
    const { getByText } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Test Loop")).toBeTruthy();
    });

    // Log tab button should have active styling
    const logTab = getByText("Log").closest("button");
    expect(logTab).toBeTruthy();
    expect(logTab!.className).toContain("border-gray-900");
  });

  test("can switch to Info tab", async () => {
    setupDefaultApi();
    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Test Loop")).toBeTruthy();
    });

    await user.click(getByText("Info"));

    await waitFor(() => {
      expect(getByText("Loop Information")).toBeTruthy();
    });
  });

  test("can switch to Prompt tab", async () => {
    setupDefaultApi();
    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Test Loop")).toBeTruthy();
    });

    await user.click(getByText("Prompt"));

    await waitFor(() => {
      expect(getByText("Original Task Prompt")).toBeTruthy();
    });
  });

  test("Prompt tab shows the loop prompt text", async () => {
    setupDefaultApi();
    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Test Loop")).toBeTruthy();
    });

    await user.click(getByText("Prompt"));

    await waitFor(() => {
      expect(getByText("Fix the bug")).toBeTruthy();
    });
  });

  test("can switch to Plan tab", async () => {
    const loop = createLoopWithStatus("running", {
      config: { id: LOOP_ID, name: "Test Loop" },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: true, content: "# My Plan\nDo things" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Test Loop")).toBeTruthy();
    });

    await user.click(getByText("Plan"));

    await waitFor(() => {
      expect(getByText(/My Plan/)).toBeTruthy();
    });
  });

  test("Plan tab shows message when no plan exists", async () => {
    setupDefaultApi();
    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Test Loop")).toBeTruthy();
    });

    await user.click(getByText("Plan"));

    await waitFor(() => {
      expect(getByText(/No plan\.md file found/)).toBeTruthy();
    });
  });

  test("can switch to Diff tab", async () => {
    setupDefaultApi();
    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Test Loop")).toBeTruthy();
    });

    await user.click(getByText("Diff"));

    await waitFor(() => {
      expect(getByText("No changes yet.")).toBeTruthy();
    });
  });

  test("Diff tab shows file changes when available", async () => {
    const loop = createLoopWithStatus("running", {
      config: { id: LOOP_ID, name: "Test Loop" },
    });
    const diffs = [
      createFileDiff({ path: "src/app.ts", status: "modified", additions: 5, deletions: 2 }),
      createFileDiff({ path: "src/new.ts", status: "added", additions: 20, deletions: 0 }),
    ];
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => diffs);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Test Loop")).toBeTruthy();
    });

    await user.click(getByText("Diff"));

    await waitFor(() => {
      expect(getByText("src/app.ts")).toBeTruthy();
      expect(getByText("src/new.ts")).toBeTruthy();
    });
  });

  test("Actions tab does not show review section when review mode is not enabled", async () => {
    setupDefaultApi();
    const { getByText, queryByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Test Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      // Actions tab should be visible
      expect(getByText("Delete Loop")).toBeTruthy();
    });

    // Review section should not appear when review mode is not enabled
    expect(queryByText(/does not have review mode enabled/)).toBeFalsy();
    expect(queryByText("Review Mode Status")).toBeFalsy();
  });

  test("Actions tab shows review info when review mode is enabled", async () => {
    const loop = createLoopWithStatus("pushed", {
      config: { id: LOOP_ID, name: "Review Loop" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 2,
          reviewBranches: ["review-1", "review-2"],
        },
      },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Review Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("Review Mode Status")).toBeTruthy();
    });
    expect(getByText("Yes")).toBeTruthy(); // Addressable: Yes
    expect(getByText("push")).toBeTruthy(); // Completion action: push
    expect(getByText("review-1")).toBeTruthy();
    expect(getByText("review-2")).toBeTruthy();
  });

  test("can switch to Actions tab", async () => {
    setupDefaultApi();
    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Test Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      // Running loop shows Delete Loop button in actions tab
      expect(getByText("Delete Loop")).toBeTruthy();
    });
  });
});

// ─── Actions tab content ─────────────────────────────────────────────────────

describe("actions tab content", () => {
  test("running loop shows delete action", async () => {
    setupDefaultApi();
    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Test Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("Delete Loop")).toBeTruthy();
    });
  });

  test("planning loops replace connect via ssh with accept plan and open ssh", async () => {
    const loop = createLoopWithStatus("planning", {
      config: { id: LOOP_ID, name: "Planning Loop" },
      state: {
        planMode: {
          active: true,
          feedbackRounds: 0,
          planningFolderCleared: false,
          isPlanReady: true,
          planContent: "# Plan",
        },
      },
    });
    const session = createSshSession({ config: { id: "ssh-loop-1", loopId: LOOP_ID } });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: true, content: "# Plan" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: true, content: "todo" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));
    api.post("/api/loops/:id/plan/accept", (req) => {
      expect(req.body).toEqual({ mode: "open_ssh" });
      return { success: true, mode: "open_ssh", sshSession: session };
    }, 200);

    let selectedSessionId: string | null = null;
    const { getByText, user } = renderWithUser(
      <LoopDetails loopId={LOOP_ID} onSelectSshSession={(sshSessionId) => { selectedSessionId = sshSessionId; }} />,
    );

    await waitFor(() => {
      expect(getByText("Planning Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));
    expect(() => getByText("Connect via ssh")).toThrow();
    await user.click(getByText("Accept Plan & Open SSH"));

    await waitFor(() => {
      expect(selectedSessionId).toBe("ssh-loop-1");
    });
  });

  describe("info tab content", () => {
    test("opens the loop code explorer from the info tab", async () => {
      setupDefaultApi({
        state: {
          git: {
            originalBranch: "main",
            workingBranch: "loop-code-explorer",
            commits: [],
            worktreePath: "/workspaces/test-project/.ralph-worktrees/loop-1",
          },
        },
      });
      const openedLoopFiles: string[] = [];
      const { getByText, user } = renderWithUser(
        <LoopDetails
          loopId={LOOP_ID}
          onOpenLoopFiles={(loopId) => {
            openedLoopFiles.push(loopId);
          }}
        />,
      );

      await waitFor(() => {
        expect(getByText("Test Loop")).toBeTruthy();
      });

      await user.click(getByText("Info"));

      await waitFor(() => {
        expect(getByText("Open code explorer")).toBeTruthy();
      });

      await user.click(getByText("Open code explorer"));

      expect(openedLoopFiles).toEqual([LOOP_ID]);
    });

    test("port-forward form only shows the remote port and submits only that value", async () => {
      setupDefaultApi();
      api.post("/api/loops/:id/port-forwards", (req) => {
        expect(req.body).toEqual({ remotePort: 3000 });
        return {
          config: {
            id: "forward-1",
            loopId: LOOP_ID,
            workspaceId: "workspace-1",
            remoteHost: "localhost",
            remotePort: 3000,
            localPort: 43000,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
          state: {
            status: "active",
          },
        };
      }, 201);

      const {
        getByLabelText,
        getByRole,
        getByText,
        queryByText,
        user,
      } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

      await waitFor(() => {
        expect(getByText("Test Loop")).toBeTruthy();
      });

      await user.click(getByText("Info"));

      await waitFor(() => {
        expect(getByText("Forward a Port")).toBeTruthy();
      });

      expect(queryByText("Remote host")).toBeNull();

      const remotePortInput = getByLabelText("Remote port") as HTMLInputElement;
      expect(remotePortInput.type).toBe("number");
      expect(remotePortInput.min).toBe("1");
      expect(remotePortInput.max).toBe("65535");
      expect(remotePortInput.getAttribute("placeholder")).toBe("");

      expect(getByRole("button", { name: "Create Port Forward" })).toBeTruthy();

      await user.type(remotePortInput, "3000");
      await user.click(getByRole("button", { name: "Create Port Forward" }));

      await waitFor(() => {
        expect(remotePortInput.value).toBe("");
      });
    });

    test("deleted loops still show connect via ssh in the info tab before purge", async () => {
      const loop = createLoopWithStatus("deleted", {
        config: { id: LOOP_ID, name: "Deleted Loop" },
      });
      api.get("/api/loops/:id", () => loop);
      api.get("/api/loops/:id/diff", () => []);
      api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
      api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
      api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
      api.get("/api/models", () => []);
      api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
      api.get("/api/preferences/log-level", () => ({ level: "info" }));

      const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

      await waitFor(() => {
        expect(getByText("Deleted Loop")).toBeTruthy();
      });

      await user.click(getByText("Info"));

      await waitFor(() => {
        expect(getByText("Connect via ssh")).toBeTruthy();
      });

      await user.click(getByText("Actions"));

      await waitFor(() => {
        expect(getByText("Purge Loop")).toBeTruthy();
      });
    });

    test("planning loops can update auto-accept and fully autonomous settings from the info tab", async () => {
      let loop = createLoopWithStatus("planning", {
        config: {
          id: LOOP_ID,
          name: "Planning Loop",
          autoAcceptPlan: false,
          fullyAutonomous: false,
        },
        state: {
          planMode: {
            active: true,
            feedbackRounds: 0,
            planningFolderCleared: false,
            isPlanReady: false,
          },
        },
      });
      api.get("/api/loops/:id", () => loop);
      api.get("/api/loops/:id/diff", () => []);
      api.get("/api/loops/:id/plan", () => ({ exists: true, content: "# Plan" }));
      api.get("/api/loops/:id/status-file", () => ({ exists: true, content: "- Task A" }));
      api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
      api.get("/api/models", () => []);
      api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
      api.get("/api/preferences/log-level", () => ({ level: "info" }));
      api.patch("/api/loops/:id", (req) => {
        expect(req.body).toEqual({ autoAcceptPlan: true, fullyAutonomous: true });
        loop = {
          ...loop,
          config: {
            ...loop.config,
            autoAcceptPlan: true,
            fullyAutonomous: true,
          },
        };
        return loop;
      });

      const { getByRole, getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

      await waitFor(() => {
        expect(getByText("Planning Loop")).toBeTruthy();
      });

      await user.click(getByText("Info"));

      await waitFor(() => {
        expect(getByText("Plan automation")).toBeTruthy();
      });

      const autoAcceptCheckbox = getByRole("checkbox", { name: /Auto-accept plan/i }) as HTMLInputElement;
      const fullyAutonomousCheckbox = getByRole("checkbox", { name: /Fully autonomous loop/i }) as HTMLInputElement;

      expect(autoAcceptCheckbox.checked).toBe(false);
      expect(fullyAutonomousCheckbox.checked).toBe(false);

      await user.click(fullyAutonomousCheckbox);

      await waitFor(() => {
        expect(api.calls("/api/loops/:id", "PATCH")).toHaveLength(1);
        expect(autoAcceptCheckbox.checked).toBe(true);
        expect(fullyAutonomousCheckbox.checked).toBe(true);
      });
    });

    test("approved plan loops can still enable fully autonomous mode from the info tab", async () => {
      let loop = createLoopWithStatus("running", {
        config: {
          id: LOOP_ID,
          name: "Accepted Plan Loop",
          planMode: true,
          autoAcceptPlan: false,
          fullyAutonomous: false,
        },
        state: {
          planMode: {
            active: false,
            feedbackRounds: 0,
            planningFolderCleared: false,
            isPlanReady: true,
          },
        },
      });
      api.get("/api/loops/:id", () => loop);
      api.get("/api/loops/:id/diff", () => []);
      api.get("/api/loops/:id/plan", () => ({ exists: true, content: "# Plan" }));
      api.get("/api/loops/:id/status-file", () => ({ exists: true, content: "- Task A" }));
      api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
      api.get("/api/models", () => []);
      api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
      api.get("/api/preferences/log-level", () => ({ level: "info" }));
      api.patch("/api/loops/:id", (req) => {
        expect(req.body).toEqual({ fullyAutonomous: true });
        loop = {
          ...loop,
          config: {
            ...loop.config,
            autoAcceptPlan: true,
            fullyAutonomous: true,
          },
        };
        return loop;
      });

      const { getByRole, getByText, queryByRole, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

      await waitFor(() => {
        expect(getByText("Accepted Plan Loop")).toBeTruthy();
      });

      await user.click(getByText("Info"));

      await waitFor(() => {
        expect(getByText("Plan automation")).toBeTruthy();
      });

      expect(queryByRole("checkbox", { name: /Auto-accept plan/i })).toBeNull();

      const fullyAutonomousCheckbox = getByRole("checkbox", { name: /Fully autonomous loop/i }) as HTMLInputElement;
      expect(fullyAutonomousCheckbox.checked).toBe(false);

      await user.click(fullyAutonomousCheckbox);

      await waitFor(() => {
        expect(api.calls("/api/loops/:id", "PATCH")).toHaveLength(1);
        expect(fullyAutonomousCheckbox.checked).toBe(true);
      });
    });
  });

  test("completed loop shows accept and delete actions", async () => {
    const loop = createLoopWithStatus("completed", {
      config: { id: LOOP_ID, name: "Completed Loop" },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Completed Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("Accept")).toBeTruthy();
      expect(getByText("Delete Loop")).toBeTruthy();
    });
  });

  test("stopped loop shows manual complete action and refreshes into accept state", async () => {
    let currentLoop = createLoopWithStatus("stopped", {
      config: { id: LOOP_ID, name: "Stopped Loop" },
    });
    api.get("/api/loops/:id", () => currentLoop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));
    api.post("/api/loops/:id/manual-complete", () => {
      currentLoop = createLoopWithStatus("completed", {
        config: { id: LOOP_ID, name: "Stopped Loop" },
      });
      return { success: true };
    });

    const { getByRole, getByText, queryByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Stopped Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("Manually complete loop")).toBeTruthy();
      expect(getByText("Delete Loop")).toBeTruthy();
    });

    await user.click(getByText("Manually complete loop"));

    await waitFor(() => {
      expect(getByRole("heading", { name: "Manually complete loop" })).toBeTruthy();
      expect(getByText(/Use this when the loop was stopped or failed/)).toBeTruthy();
    });

    const dialog = getByRole("dialog");
    const confirmButton = within(dialog).getByRole("button", { name: "Manually complete loop" });
    await user.click(confirmButton);

    await waitFor(() => {
      expect(api.calls("/api/loops/:id/manual-complete", "POST")).toHaveLength(1);
      expect(getByText("Accept")).toBeTruthy();
      expect(queryByText("Manually complete loop")).toBeNull();
    });
  });

  test("pushed loop shows go to PR alongside review actions", async () => {
    const loop = createLoopWithStatus("pushed", {
      config: { id: LOOP_ID, name: "Pushed Loop" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 1,
          reviewBranches: [],
        },
      },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/pull-request", () => ({
      enabled: true,
      destinationType: "existing_pr",
      url: "https://github.com/example/repo/pull/1",
    }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Pushed Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("Go to PR")).toBeTruthy();
      expect(getByText("Automatic PR flow")).toBeTruthy();
      expect(getByText("Address Comments")).toBeTruthy();
      expect(getByText("Mark as Merged")).toBeTruthy();
      expect(getByText("Purge Loop")).toBeTruthy();
    });
  });

  test("merged loop hides the mark as merged action", async () => {
    const loop = createLoopWithStatus("merged", {
      config: { id: LOOP_ID, name: "Merged Loop" },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, queryByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Merged Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("Purge Loop")).toBeTruthy();
    });
    expect(queryByText("Mark as Merged")).toBeNull();
    expect(queryByText("Keep this loop as merged after the branch landed elsewhere")).toBeNull();
  });

  test("pushed loop disables go to PR when backend reports gh is unavailable", async () => {
    const loop = createLoopWithStatus("pushed", {
      config: { id: LOOP_ID, name: "Pushed Loop" },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/pull-request", () => ({
      enabled: false,
      destinationType: "disabled",
      disabledReason: "GitHub CLI is not available in the loop environment.",
    }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByRole, getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Pushed Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByRole("button", { name: /Go to PR/i })).toBeTruthy();
    });
    const button = getByRole("button", { name: /Go to PR/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(getByText("GitHub CLI is not available in the loop environment.")).toBeTruthy();
  });

  test("pushed loop keeps PR destination failures non-blocking", async () => {
    const loop = createLoopWithStatus("pushed", {
      config: { id: LOOP_ID, name: "Pushed Loop" },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/pull-request", () => {
      throw new MockApiError(500, { error: "internal_error" });
    });
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByRole, getByText, queryByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Pushed Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByRole("button", { name: /Go to PR/i })).toBeTruthy();
    });

    const button = getByRole("button", { name: /Go to PR/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(getByText("Failed to load pull request information.")).toBeTruthy();
    expect(queryByText("Failed to get pull request destination: Internal Server Error")).toBeNull();
  });

  test("pushed loop opens the create PR page when no PR exists", async () => {
    const loop = createLoopWithStatus("pushed", {
      config: { id: LOOP_ID, name: "Pushed Loop" },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/pull-request", () => ({
      enabled: true,
      destinationType: "create_pr",
      url: "https://github.com/example/repo/compare/main...feature%2Floop?expand=1",
    }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByRole, getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Pushed Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    const button = await waitFor(() => getByRole("button", { name: /Go to PR/i }) as HTMLButtonElement);
    await waitFor(() => {
      expect(button.disabled).toBe(false);
    });

    await user.click(button);

    await waitFor(() => {
      expect(openCalls).toHaveLength(1);
    });
    expect(openCalls[0]).toEqual({
      url: "https://github.com/example/repo/compare/main...feature%2Floop?expand=1",
      target: "_blank",
      features: "noopener,noreferrer",
    });
  });

  test("pushed loop opens the existing PR when one already exists", async () => {
    const loop = createLoopWithStatus("pushed", {
      config: { id: LOOP_ID, name: "Pushed Loop" },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/pull-request", () => ({
      enabled: true,
      destinationType: "existing_pr",
      url: "https://github.com/example/repo/pull/42",
    }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByRole, getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Pushed Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    const button = await waitFor(() => getByRole("button", { name: /Go to PR/i }) as HTMLButtonElement);
    await waitFor(() => {
      expect(button.disabled).toBe(false);
    });
    expect(button.type).toBe("button");

    await user.click(button);

    await waitFor(() => {
      expect(openCalls).toHaveLength(1);
    });
    expect(openCalls[0]).toEqual({
      url: "https://github.com/example/repo/pull/42",
      target: "_blank",
      features: "noopener,noreferrer",
    });
  });

  test("pushed loop opens automatic PR flow confirmation modal", async () => {
    const loop = createLoopWithStatus("pushed", {
      config: { id: LOOP_ID, name: "Pushed Loop" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 0,
          reviewBranches: [],
        },
      },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/pull-request", () => ({
      enabled: true,
      destinationType: "existing_pr",
      url: "https://github.com/example/repo/pull/42",
    }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Pushed Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));
    await waitFor(() => {
      expect(getByText("Automatic PR flow")).toBeTruthy();
    });

    await user.click(getByText("Automatic PR flow"));

    await waitFor(() => {
      expect(getByText("Start Automatic PR flow?")).toBeTruthy();
    });
  });

  test("pushed loop shows stop automatic PR flow state when enabled", async () => {
    const loop = createLoopWithStatus("pushed", {
      config: { id: LOOP_ID, name: "Pushed Loop" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 0,
          reviewBranches: [],
        },
        automaticPrFlow: {
          enabled: true,
          status: "monitoring",
          startedAt: "2026-04-11T04:00:00.000Z",
          updatedAt: "2026-04-11T04:00:00.000Z",
          lastCheckedAt: "2026-04-11T04:00:00.000Z",
          pullRequestNumber: 42,
          pullRequestUrl: "https://github.com/example/repo/pull/42",
          handledItems: [],
        },
      },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/pull-request", () => ({
      enabled: true,
      destinationType: "existing_pr",
      url: "https://github.com/example/repo/pull/42",
    }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, queryByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Pushed Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("Stop Automatic PR flow")).toBeTruthy();
    });
    expect(queryByText("Automatic PR flow")).toBeNull();
    expect(getByText("PR: #42")).toBeTruthy();
  });
});

// ─── Modals ──────────────────────────────────────────────────────────────────

describe("delete modal", () => {
  test("opens delete modal from actions tab", async () => {
    setupDefaultApi();
    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Test Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("Delete Loop")).toBeTruthy();
    });

    // Click the Delete Loop action button in the actions tab
    const deleteBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Delete Loop") && b.textContent?.includes("Cancel and delete"),
    );
    expect(deleteBtn).toBeTruthy();
    await user.click(deleteBtn!);

    await waitFor(() => {
      // The DeleteLoopModal shows a confirmation
      expect(getByText(/Are you sure/)).toBeTruthy();
    });
  });
});

describe("accept modal", () => {
  test("opens accept modal from actions tab for completed loop", async () => {
    const loop = createLoopWithStatus("completed", {
      config: { id: LOOP_ID, name: "Accept Loop" },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Accept Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      // The Accept action button in the actions tab
      const acceptBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Accept") && b.textContent?.includes("Accept changes"),
      );
      expect(acceptBtn).toBeTruthy();
    });

    const acceptBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Accept") && b.textContent?.includes("Accept changes"),
    );
    await user.click(acceptBtn!);

    await waitFor(() => {
      expect(getByText("Finalize Loop")).toBeTruthy();
    });
  });
});

describe("purge modal", () => {
  test("opens purge modal from actions tab for pushed loop", async () => {
    const loop = createLoopWithStatus("pushed", {
      config: { id: LOOP_ID, name: "Purge Loop" },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Purge Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      const purgeBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Purge Loop") && b.textContent?.includes("Delete this loop"),
      );
      expect(purgeBtn).toBeTruthy();
    });

    const purgeBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Purge Loop") && b.textContent?.includes("Delete this loop"),
    );
    await user.click(purgeBtn!);

    await waitFor(() => {
      // Purge modal confirmation
      expect(getByText(/permanently delete/i)).toBeTruthy();
    });
  });
});

describe("address comments modal", () => {
  test("opens address comments modal from actions tab", async () => {
    const loop = createLoopWithStatus("pushed", {
      config: { id: LOOP_ID, name: "Comment Loop" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 1,
          reviewBranches: [],
        },
      },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Comment Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      const addrBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Address Comments") && b.textContent?.includes("Submit comments"),
      );
      expect(addrBtn).toBeTruthy();
    });

    const addrBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Address Comments") && b.textContent?.includes("Submit comments"),
    );
    await user.click(addrBtn!);

    await waitFor(() => {
      expect(getByText("Address Reviewer Comments")).toBeTruthy();
    });
  });
});

describe("mark merged modal", () => {
  test("opens mark merged modal from actions tab", async () => {
    const loop = createLoopWithStatus("pushed", {
      config: { id: LOOP_ID, name: "Merge Loop" },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Merge Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      const mergeBtn = Array.from(document.querySelectorAll("button")).find(
        (b) => b.textContent?.includes("Mark as Merged") && b.textContent?.includes("Keep this loop as merged"),
      );
      expect(mergeBtn).toBeTruthy();
    });

    const mergeBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Mark as Merged") && b.textContent?.includes("Keep this loop as merged"),
    );
    await user.click(mergeBtn!);

    await waitFor(() => {
      expect(getByText(/keep the loop as merged/i)).toBeTruthy();
    });
  });
});

describe("rename modal", () => {
  test("opens rename modal when rename button is clicked", async () => {
    setupDefaultApi();
    const { getByText, container, user } = renderWithUser(
      <LoopDetails loopId={LOOP_ID} />,
    );

    await waitFor(() => {
      expect(getByText("Test Loop")).toBeTruthy();
    });

    const renameBtn = container.querySelector('button[aria-label="Rename loop"]');
    expect(renameBtn).toBeTruthy();

    await user.click(renameBtn as HTMLElement);

    await waitFor(() => {
      expect(getByText("Rename Loop")).toBeTruthy();
    });
  });
});

// ─── Planning mode ───────────────────────────────────────────────────────────

describe("planning mode", () => {
  test("shows unified tab UI with plan tab active when in planning status", async () => {
    const loop = createLoopWithStatus("planning", {
      config: { id: LOOP_ID, name: "Planning Loop" },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: true, content: "# The Plan" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Planning Loop")).toBeTruthy();
    });

    // All tabs should be visible in the unified UI
    await waitFor(() => {
      expect(getByText("Plan")).toBeTruthy();
      expect(getByText("Actions")).toBeTruthy();
      expect(getByText("Log")).toBeTruthy();
    });
  });

  test("shows Planning status badge for planning loop", async () => {
    const loop = createLoopWithStatus("planning", {
      config: { id: LOOP_ID, name: "Planning Loop" },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Planning")).toBeTruthy();
    });
  });

  test("keeps the waiting state without a shared error banner when planning files hit transient no_worktree", async () => {
    const loop = createLoopWithStatus("planning", {
      config: { id: LOOP_ID, name: "Startup Planning Loop" },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => {
      throw new MockApiError(400, {
        error: "no_worktree",
        message: "Loop is configured to use a worktree, but no worktree path is available.",
      });
    });
    api.get("/api/loops/:id/status-file", () => {
      throw new MockApiError(400, {
        error: "no_worktree",
        message: "Loop is configured to use a worktree, but no worktree path is available.",
      });
    });
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, queryByText } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Startup Planning Loop")).toBeTruthy();
    });

    await waitFor(() => {
      expect(getByText("Waiting for AI to generate plan...")).toBeTruthy();
    });

    expect(queryByText(/Failed to get plan/)).toBeNull();
  });

  test("still shows the shared error banner for real plan fetch failures", async () => {
    const loop = createLoopWithStatus("planning", {
      config: { id: LOOP_ID, name: "Broken Planning Loop" },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => {
      throw new MockApiError(500, {
        error: "internal_error",
        message: "Unexpected failure while loading plan",
      });
    });
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Broken Planning Loop")).toBeTruthy();
    });

    await waitFor(() => {
      expect(getByText(/Failed to get plan/)).toBeTruthy();
    });
  });

  test("shows Plan Ready badge when plan is ready for review", async () => {
    const loop = createLoopWithStatus("planning", {
      config: { id: LOOP_ID, name: "Plan Ready Loop" },
      state: {
        planMode: {
          active: true,
          feedbackRounds: 0,
          planningFolderCleared: false,
          isPlanReady: true,
        },
      },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: true, content: "# Ready Plan" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Plan Ready")).toBeTruthy();
    });
  });

  test("shows spinner in log panel when planning with isPlanReady=false", async () => {
    // When status is "planning" and isPlanReady is false, the LogViewer
    // should receive isActive=true so it shows the "Working..." spinner
    const loop = createLoopWithStatus("planning", {
      config: { id: LOOP_ID, name: "Active Planning Loop" },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Active Planning Loop")).toBeTruthy();
    });

    // Switch to Log tab (planning mode defaults to Plan tab)
    await user.click(getByText("Log"));

    // The LogViewer should show the spinner since isPlanReady is false
    await waitFor(() => {
      expect(getByText("Working...")).toBeTruthy();
    });
  });

  test("keeps the plan panel vertically scrollable without panel-level horizontal scrolling", async () => {
    const loop = createLoopWithStatus("planning", {
      config: { id: LOOP_ID, name: "Wrapped Plan Loop" },
      state: {
        planMode: {
          active: true,
          feedbackRounds: 0,
          planningFolderCleared: false,
          isPlanReady: true,
        },
      },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({
      exists: true,
      content: "AVeryLongTokenWithoutSpacesThatShouldStillWrapInsideThePlanPanelInsteadOfExpandingTheWholeContainer",
    }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: false }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { container, getByText } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Wrapped Plan Loop")).toBeTruthy();
    });

    const panel = container.querySelector(".dark-scrollbar.overflow-y-auto") as HTMLElement | null;
    expect(panel).toBeTruthy();
    expect(panel?.className).toContain("overflow-x-hidden");
    expect(panel?.className).toContain("overflow-y-auto");
  });

  test("does not show spinner in log panel when planning with isPlanReady=true", async () => {
    // When status is "planning" and isPlanReady is true, the LogViewer
    // should receive isActive=false so it shows "No logs yet. Waiting for activity."
    const loop = createLoopWithStatus("planning", {
      config: { id: LOOP_ID, name: "Plan Ready No Spinner" },
      state: {
        planMode: {
          active: true,
          feedbackRounds: 0,
          planningFolderCleared: false,
          isPlanReady: true,
        },
      },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: true, content: "# Plan" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, queryByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Plan Ready No Spinner")).toBeTruthy();
    });

    // Switch to Log tab
    await user.click(getByText("Log"));

    // The LogViewer should NOT show the spinner since isPlanReady is true
    await waitFor(() => {
      expect(getByText("No logs yet. Waiting for activity.")).toBeTruthy();
    });
    expect(queryByText("Working...")).toBeNull();
  });

  test("renders planning loops when isPlanReady=false", async () => {
    const loop = createLoopWithStatus("planning", {
      config: { id: LOOP_ID, name: "Cyan Indicator Loop" },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Cyan Indicator Loop")).toBeTruthy();
    });

  });

  test("renders planning loops when isPlanReady=true", async () => {
    const loop = createLoopWithStatus("planning", {
      config: { id: LOOP_ID, name: "Amber Indicator Loop" },
      state: {
        planMode: {
          active: true,
          feedbackRounds: 0,
          planningFolderCleared: false,
          isPlanReady: true,
        },
      },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: true, content: "# Plan" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Amber Indicator Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("Accept Plan & Start Loop")).toBeTruthy();
      expect(getByText("Accept Plan & Open SSH")).toBeTruthy();
      expect(getByText("Discard Plan")).toBeTruthy();
    });

  });
});

// ─── LoopActionBar ───────────────────────────────────────────────────────────

describe("loop action bar", () => {
  test("shows action bar for active loops", async () => {
    setupDefaultApi();
    const { getByRole } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByRole("textbox", { name: "Loop message" })).toBeTruthy();
    });
  });

  test("shows Stop for an empty active composer and calls the stop API", async () => {
    setupDefaultApi();
    const { getByRole, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Stop" })).toBeTruthy();
    });

    await user.click(getByRole("button", { name: "Stop" }));

    await waitFor(() => {
      expect(api.calls("/api/loops/:id/stop", "POST")).toHaveLength(1);
    });
  });

  test("does not show action bar for non-addressable final-state loops", async () => {
    const loop = createLoopWithStatus("merged", {
      config: { id: LOOP_ID, name: "Merged Loop" },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, queryByRole } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Merged Loop")).toBeTruthy();
    });

    expect(queryByRole("textbox", { name: "Loop message" })).toBeNull();
  });

  test("shows restart composer for addressable merged loops and submits follow-up", async () => {
    const loop = createLoopWithStatus("merged", {
      config: { id: LOOP_ID, name: "Merged Loop" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "merge",
          reviewCycles: 0,
          reviewBranches: ["merged-loop-a1b2c3d"],
        },
      },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));
    api.post("/api/loops/:id/follow-up", () => ({ success: true }));

    const { getByRole, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Restart" })).toBeTruthy();
    });

    await user.type(getByRole("textbox", { name: "Loop message" }), "Please revise this");
    await user.click(getByRole("button", { name: "Restart" }));

    await waitFor(() => {
      expect(api.calls("/api/loops/:id/follow-up", "POST")).toHaveLength(1);
    });
  });

  test("shows restart composer for completed loops and submits follow-up", async () => {
    const loop = createLoopWithStatus("completed", {
      config: { id: LOOP_ID, name: "Completed Loop", prompt: "Finish task" },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));
    api.post("/api/loops/:id/follow-up", () => ({ success: true }));

    const { getByRole, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Restart" })).toBeTruthy();
    });

    await user.type(getByRole("textbox", { name: "Loop message" }), "Continue from the last result");
    await user.click(getByRole("button", { name: "Restart" }));

    await waitFor(() => {
      expect(api.calls("/api/loops/:id/follow-up", "POST")).toHaveLength(1);
    });
  });


  test("shows send feedback for plan-ready loops and submits feedback", async () => {
    const loop = createLoopWithStatus("planning", {
      config: { id: LOOP_ID, name: "Plan Loop", prompt: "Draft a plan" },
      state: {
        planMode: {
          active: true,
          feedbackRounds: 1,
          planningFolderCleared: false,
          isPlanReady: true,
        },
      },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: true, content: "## Plan\n- Step 1" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: true, content: "- Task A" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));
    api.post("/api/loops/:id/plan/feedback", () => ({ success: true }));

    const { getByRole, queryByRole, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Send Feedback" })).toBeTruthy();
    });
    expect(queryByRole("button", { name: "Stop" })).toBeNull();

    await user.type(getByRole("textbox", { name: "Plan feedback" }), "Please expand step 1");
    await user.click(getByRole("button", { name: "Send Feedback" }));

    await waitFor(() => {
      expect(api.calls("/api/loops/:id/plan/feedback", "POST")).toHaveLength(1);
    });
  });
});

// ─── Error display ───────────────────────────────────────────────────────────

describe("error display", () => {
  test("shows loop error when loop has error state", async () => {
    const loop = createLoopWithStatus("failed", {
      config: { id: LOOP_ID, name: "Failed Loop" },
      state: {
        error: {
          message: "Something went wrong in iteration 2",
          iteration: 2,
          timestamp: new Date().toISOString(),
        },
      },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Loop Error")).toBeTruthy();
    });
    expect(getByText("Something went wrong in iteration 2")).toBeTruthy();
    expect(getByText(/Iteration: 2/)).toBeTruthy();
  });
});

// ─── Log tab details ─────────────────────────────────────────────────────────

describe("log tab", () => {
  test("shows the log tab without a collapsible Logs section", async () => {
    setupDefaultApi();
    const { getByLabelText, getByText, queryByText } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Log")).toBeTruthy();
      expect(getByLabelText("Show system info")).toBeTruthy();
    });
    expect(queryByText("Logs")).toBeNull();
    expect(queryByText("TODOs")).toBeNull();
  });

  test("shows log filter controls with full accessible labels", async () => {
    setupDefaultApi();
    const { getByLabelText, getByRole } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByLabelText("Show system info")).toBeTruthy();
      expect(getByLabelText("Show reasoning")).toBeTruthy();
      expect(getByLabelText("Show tools")).toBeTruthy();
      expect(getByLabelText("Autoscroll")).toBeTruthy();
      expect(getByRole("button", { name: "Enter focus mode" })).toBeTruthy();
    });
  });

  test("keeps the log filter bar as a single-row horizontal scroller on small screens", async () => {
    setupDefaultApi();
    const { getByTestId } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByTestId("loop-log-controls")).toBeTruthy();
    });

    const controls = getByTestId("loop-log-controls");
    expect(controls.className).toContain("overflow-x-auto");
    expect(controls.className).toContain("whitespace-nowrap");
    expect(controls.className).toContain("sm:flex-wrap");
  });

  test("enables show tools by default and renders a collapsed tool-call container", async () => {
    setupDefaultApi({
      state: {
        toolCalls: [createPersistedToolCall({ name: "read", input: { path: "/workspaces/test-project/README.md" }, status: "completed" })],
      },
    });
    const { container, getByLabelText, getByRole, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByRole("button", { name: /^1 tool call$/i })).toBeTruthy();
    });

    const showToolsCheckbox = getByLabelText("Show tools") as HTMLInputElement;
    const toggle = getByRole("button", { name: /^1 tool call$/i });
    const panel = container.querySelector("[data-tool-group-panel='true']") as HTMLDivElement | null;
    const controlledPanelId = toggle.getAttribute("aria-controls") ?? "";
    expect(showToolsCheckbox.checked).toBe(true);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(controlledPanelId).not.toBe("");
    expect(panel?.id).toBe(controlledPanelId);
    expect(panel?.hidden).toBe(true);

    await user.click(toggle);

    await waitFor(() => {
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      expect(panel?.hidden).toBe(false);
    });
  });

  test("uses the loop worktree root when shortening tool paths", async () => {
    setupDefaultApi({
      config: {
        directory: "/workspaces/test-project",
      },
      state: {
        git: {
          originalBranch: "main",
          workingBranch: "test-loop",
          worktreePath: "/workspaces/test-project/.ralph-worktrees/test-loop",
          commits: [],
        },
        toolCalls: [createPersistedToolCall({
          name: "read",
          input: {
            path: "/workspaces/test-project/.ralph-worktrees/test-loop/src/persistence/auth.ts",
            view_range: [20, 330],
          },
          status: "completed",
        })],
      },
    });
    const { getByText, queryByText } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("View src/persistence/auth.ts:20-330")).toBeTruthy();
    });
    expect(queryByText("View .ralph-worktrees/test-loop/src/persistence/auth.ts:20-330")).toBeNull();
  });

  test("shows autoscroll toggle", async () => {
    setupDefaultApi();
    const { getByText } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Autoscroll")).toBeTruthy();
    });
  });

  test("renders the log transcript directly on the loop log panel surface", async () => {
    setupDefaultApi({
      state: {
        messages: [createPersistedMessage({ role: "user", content: "Use the whole panel" })],
      },
    });
    const { getByTestId, getByText } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Use the whole panel")).toBeTruthy();
    });

    const logPanel = getByTestId("loop-log-panel");
    expect(within(logPanel).getByText("Use the whole panel")).toBeTruthy();
    expect(logPanel.className).toContain("bg-gray-50");
    expect(logPanel.className).toContain("dark:bg-[#171717]");

    const logViewer = logPanel.querySelector("#logs-viewer") as HTMLElement | null;
    expect(logViewer).not.toBeNull();

    const transcriptShell = getByTestId("conversation-transcript");
    expect(logViewer).toContainElement(transcriptShell);
    expect(transcriptShell.className).toContain(loopDetailsTabPaddingClassName);
  });

  test("enters log focus mode while keeping the message composer available", async () => {
    setupDefaultApi();
    const { getByRole, queryByRole, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByRole("button", { name: "Enter focus mode" })).toBeInTheDocument();
    });

    await user.click(getByRole("button", { name: "Enter focus mode" }));

    await waitFor(() => {
      expect(getByRole("button", { name: "Exit focus mode" })).toBeInTheDocument();
    });

    expect(queryByRole("button", { name: "Info" })).toBeNull();
    expect(queryByRole("button", { name: "Prompt" })).toBeNull();
    expect(queryByRole("button", { name: "Hide logs" })).toBeNull();
    expect(queryByRole("button", { name: "Show logs" })).toBeNull();
    expect(getByRole("textbox", { name: "Loop message" })).toBeInTheDocument();
    expect(getByRole("button", { name: "Autoscroll" })).toBeInTheDocument();
  });

  test("restores log focus mode from localStorage on remount", async () => {
    setupDefaultApi();
    const firstRender = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(firstRender.getByRole("button", { name: "Enter focus mode" })).toBeInTheDocument();
    });

    await firstRender.user.click(firstRender.getByRole("button", { name: "Enter focus mode" }));

    await waitFor(() => {
      expect(window.localStorage.getItem("ralpher-loop-log-focus-mode")).toBe("true");
    });

    firstRender.unmount();

    const secondRender = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(secondRender.getByRole("button", { name: "Exit focus mode" })).toBeInTheDocument();
    });
  });

});

// ─── Prompt tab details ──────────────────────────────────────────────────────

describe("prompt tab", () => {
  test("shows pending prompt when loop has one", async () => {
    const loop = createLoopWithStatus("running", {
      config: { id: LOOP_ID, name: "Pending Loop", prompt: "Initial task" },
      state: {
        pendingPrompt: "Please also fix the tests",
      },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Pending Loop")).toBeTruthy();
    });

    await user.click(getByText("Prompt"));

    await waitFor(() => {
      expect(getByText("Next Message")).toBeTruthy();
      // The pending prompt text appears in the Prompt tab <pre>
      const matches = document.querySelectorAll("pre");
      const pendingPre = Array.from(matches).find(
        (el) => el.textContent === "Please also fix the tests",
      );
      expect(pendingPre).toBeTruthy();
    });
  });

  test("shows tip about action bar for active loops", async () => {
    setupDefaultApi();
    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Test Loop")).toBeTruthy();
    });

    await user.click(getByText("Prompt"));

    await waitFor(() => {
      expect(getByText(/Stop the current run before sending a new message/)).toBeTruthy();
    });
  });

  test("does not show the inactive action-bar legend for non-active loops", async () => {
    const loop = createLoopWithStatus("completed", {
      config: { id: LOOP_ID, name: "Done Loop", prompt: "Fix bug" },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, queryByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Done Loop")).toBeTruthy();
    });

    await user.click(getByText("Prompt"));

    await waitFor(() => {
      expect(getByText("Original Task Prompt")).toBeTruthy();
    });

    expect(queryByText(/Use the action bar to send the next message or restart/)).toBeNull();
  });
});

// ─── Status badge variations ─────────────────────────────────────────────────

describe("status badge variations", () => {
  const statuses = [
    { status: "completed" as const, label: "Completed" },
    { status: "failed" as const, label: "Failed" },
    { status: "stopped" as const, label: "Stopped" },
    { status: "merged" as const, label: "Merged" },
    { status: "pushed" as const, label: "Pushed" },
    { status: "deleted" as const, label: "Deleted" },
  ];

  for (const { status, label } of statuses) {
    test(`shows ${label} badge for ${status} loop`, async () => {
      const loop = createLoopWithStatus(status, {
        config: { id: LOOP_ID, name: `${label} Loop` },
      });
      api.get("/api/loops/:id", () => loop);
      api.get("/api/loops/:id/diff", () => []);
      api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
      api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
      api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
      api.get("/api/models", () => []);
      api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
      api.get("/api/preferences/log-level", () => ({ level: "info" }));

      const { getByText } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

      await waitFor(() => {
        expect(getByText(label)).toBeTruthy();
      });
    });
  }
});

// ─── Actions tab comment history (review section) ────────────────────────────

describe("actions tab comment history", () => {
  test("shows comments grouped by review cycle", async () => {
    const loop = createLoopWithStatus("pushed", {
      config: { id: LOOP_ID, name: "Review Loop" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 2,
          reviewBranches: [],
        },
      },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({
      success: true,
      comments: [
        {
          id: "c1",
          loopId: LOOP_ID,
          reviewCycle: 1,
          commentText: "Fix the formatting",
          status: "addressed",
          createdAt: new Date().toISOString(),
          addressedAt: new Date().toISOString(),
        },
        {
          id: "c2",
          loopId: LOOP_ID,
          reviewCycle: 2,
          commentText: "Add more tests",
          status: "pending",
          createdAt: new Date().toISOString(),
        },
      ],
    }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Review Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("Review Cycle 1")).toBeTruthy();
      expect(getByText("Review Cycle 2")).toBeTruthy();
    });
    expect(getByText("Fix the formatting")).toBeTruthy();
    expect(getByText("Add more tests")).toBeTruthy();
    expect(getByText("Addressed")).toBeTruthy();
    expect(getByText("Pending")).toBeTruthy();
  });

  test("shows no comments message when empty", async () => {
    const loop = createLoopWithStatus("pushed", {
      config: { id: LOOP_ID, name: "Review Loop" },
      state: {
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 0,
          reviewBranches: [],
        },
      },
    });
    api.get("/api/loops/:id", () => loop);
    api.get("/api/loops/:id/diff", () => []);
    api.get("/api/loops/:id/plan", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/status-file", () => ({ exists: false, content: "" }));
    api.get("/api/loops/:id/comments", () => ({ success: true, comments: [] }));
    api.get("/api/models", () => []);
    api.get("/api/preferences/markdown-rendering", () => ({ enabled: true }));
    api.get("/api/preferences/log-level", () => ({ level: "info" }));

    const { getByText, user } = renderWithUser(<LoopDetails loopId={LOOP_ID} />);

    await waitFor(() => {
      expect(getByText("Review Loop")).toBeTruthy();
    });

    await user.click(getByText("Actions"));

    await waitFor(() => {
      expect(getByText("No comments yet.")).toBeTruthy();
    });
  });
});
