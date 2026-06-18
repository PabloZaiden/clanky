import { describe, expect, test } from "bun:test";

import { buildWorkspaceActionItems } from "../../src/components/app-shell/shell-action-items";
import type { ShellRoute } from "../../src/components/app-shell/shell-types";
import { getDefaultServerSettings } from "../../src/types/settings";
import type { Workspace } from "../../src/types/workspace";

function createWorkspace(): Workspace {
  return {
    id: "workspace-1",
    name: "Workspace One",
    directory: "/workspaces/one",
    serverSettings: getDefaultServerSettings(),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("workspace action items", () => {
  test("includes New Agent with workspace-scoped compose navigation", () => {
    const routes: ShellRoute[] = [];
    const items = buildWorkspaceActionItems({
      workspace: createWorkspace(),
      githubUrl: null,
      pullingLatestChanges: false,
      onNavigate: (route) => routes.push(route),
      onPullLatestChanges: () => {},
      onOpenGitHub: () => {},
    });

    const newAgentItem = items.find((item) => item.label === "New Agent");
    expect(newAgentItem).toBeDefined();
    newAgentItem?.onClick();

    expect(routes).toEqual([
      { view: "compose", kind: "agent", scopeId: "workspace-1" },
    ]);
  });
});
