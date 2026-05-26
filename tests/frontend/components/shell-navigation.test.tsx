import { describe, expect, test } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import {
  getHashForShellRoute,
  getShellRouteUrl,
  isModifiedNavigationClick,
  replaceHashRoute,
  replaceShellRoute,
} from "@/components/app-shell/shell-navigation";

describe("shell navigation helpers", () => {
  test("builds hash routes for shell destinations", () => {
    expect(getHashForShellRoute({ view: "task", taskId: "task-1" })).toBe("/task/task-1");
    expect(getHashForShellRoute({ view: "code-explorer" })).toBe("/code-explorer");
    expect(
      getHashForShellRoute({
        view: "code-explorer",
        target: {
          contentType: "chat",
          chatId: "chat-1",
          startDirectory: "/workspaces/frontend/.chat-worktree",
          filePath: "src/index.ts",
        },
      }),
    ).toBe("/code-explorer/chat/chat-1?startDirectory=%2Fworkspaces%2Ffrontend%2F.chat-worktree&filePath=src%2Findex.ts");
    expect(
      getHashForShellRoute({
        view: "task-files",
        taskId: "task-1",
        startDirectory: "/workspaces/frontend/.clanky-worktrees/task-1",
      }),
    ).toBe("/task-files/task-1?startDirectory=%2Fworkspaces%2Ffrontend%2F.clanky-worktrees%2Ftask-1");
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

  test("replaces hash routes without adding history entries", () => {
    window.history.replaceState({ marker: "initial" }, "", "/#/initial");
    const initialLength = window.history.length;
    const hashChanges: HashChangeEvent[] = [];
    const onHashChange = (event: HashChangeEvent) => hashChanges.push(event);

    window.addEventListener("hashchange", onHashChange);
    try {
      replaceShellRoute({ view: "task", taskId: "task-1" });
    } finally {
      window.removeEventListener("hashchange", onHashChange);
    }

    expect(window.location.hash).toBe("#/task/task-1");
    expect(window.history.length).toBe(initialLength);
    expect(window.history.state).toEqual({ marker: "initial" });
    expect(hashChanges).toHaveLength(1);
    expect(hashChanges[0]!.oldURL).toBe("http://localhost:3000/#/initial");
    expect(hashChanges[0]!.newURL).toBe("http://localhost:3000/#/task/task-1");
  });

  test("does not emit duplicate hash changes for the current hash route", () => {
    window.history.replaceState({}, "", "/#/task/task-1");
    const initialLength = window.history.length;
    let hashChangeCount = 0;
    const onHashChange = () => {
      hashChangeCount += 1;
    };

    window.addEventListener("hashchange", onHashChange);
    try {
      replaceHashRoute("/task/task-1");
    } finally {
      window.removeEventListener("hashchange", onHashChange);
    }

    expect(window.location.hash).toBe("#/task/task-1");
    expect(window.history.length).toBe(initialLength);
    expect(hashChangeCount).toBe(0);
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
