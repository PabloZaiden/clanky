import { describe, expect, test } from "bun:test";
import type { Workspace } from "../../src/types";
import { buildPreviewCliCommand, getPreviewWorkspaceReference } from "../../src/utils";

function workspace(id: string, name: string): Workspace {
  const now = new Date().toISOString();
  return {
    id,
    name,
    directory: `/workspaces/${id}`,
    serverSettings: {
      agent: {
        provider: "opencode",
        transport: "stdio",
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe("preview command suggestion", () => {
  test("uses the workspace name when it is unique", () => {
    const app = workspace("workspace-1", "App");

    expect(getPreviewWorkspaceReference(app, [
      app,
      workspace("workspace-2", "Docs"),
    ])).toBe("App");
  });

  test("uses the workspace ID when the name is ambiguous", () => {
    const app = workspace("workspace-1", "Duplicate");

    expect(getPreviewWorkspaceReference(app, [
      app,
      workspace("workspace-2", "Duplicate"),
    ])).toBe("workspace-1");
  });

  test("builds a copyable CLI command with shell quoting and default port", () => {
    const app = workspace("workspace-1", "My App");

    expect(buildPreviewCliCommand({
      workspace: app,
      workspaces: [app],
      port: " ",
    })).toBe("clanky preview --workspace 'My App' --port 3000");
  });
});
