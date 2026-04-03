import { describe, expect, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import {
  getHashForShellRoute,
  getShellRouteUrl,
  isModifiedNavigationClick,
} from "@/components/app-shell/shell-navigation";

describe("shell navigation helpers", () => {
  test("builds hash routes for shell destinations", () => {
    expect(getHashForShellRoute({ view: "loop", loopId: "loop-1" })).toBe("/loop/loop-1");
    expect(
      getHashForShellRoute({
        view: "loop-files",
        loopId: "loop-1",
        startDirectory: "/workspaces/frontend/.ralph-worktrees/loop-1",
      }),
    ).toBe("/loop-files/loop-1?startDirectory=%2Fworkspaces%2Ffrontend%2F.ralph-worktrees%2Floop-1");
    expect(
      getHashForShellRoute({
        view: "workspace-files",
        workspaceId: "workspace-1",
        startDirectory: "/workspaces/frontend/src",
      }),
    ).toBe("/workspace-files/workspace-1?startDirectory=%2Fworkspaces%2Ffrontend%2Fsrc");
    expect(getHashForShellRoute({ view: "compose", kind: "ssh-session", scopeId: "server-1" })).toBe(
      "/new/ssh-session/server-1",
    );
  });

  test("builds absolute shell URLs for new-tab navigation", () => {
    expect(getShellRouteUrl({ view: "workspace", workspaceId: "workspace-1" })).toBe(
      "http://localhost:3000/#/workspace/workspace-1",
    );
  });

  test("detects modified navigation clicks", () => {
    let metaClick = false;
    let ctrlClick = false;
    let plainClick = true;

    const { getByRole } = render(
      <button
        type="button"
        onClick={(event) => {
          if (event.metaKey) {
            metaClick = isModifiedNavigationClick(event);
            return;
          }
          if (event.ctrlKey) {
            ctrlClick = isModifiedNavigationClick(event);
            return;
          }
          plainClick = isModifiedNavigationClick(event);
        }}
      >
        Probe
      </button>,
    );

    const probe = getByRole("button", { name: "Probe" });
    fireEvent.click(probe, { metaKey: true });
    fireEvent.click(probe, { ctrlKey: true });
    fireEvent.click(probe);

    expect(metaClick).toBe(true);
    expect(ctrlClick).toBe(true);
    expect(plainClick).toBe(false);
  });
});
