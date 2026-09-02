import { describe, expect, test } from "bun:test";
import type { Workspace } from "@/shared";
import { buildPreviewCliCommand } from "../../src/utils";

function workspace(id: string, name: string): Workspace {
  const now = new Date().toISOString();
  return {
    id,
    name,
    directory: `/workspaces/${id}`,
    workspaceType: "git",
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

  test("builds a copyable CLI command with shell quoting and default port", () => {
    const app = workspace("workspace-1", "My App");

    expect(buildPreviewCliCommand({
      workspace: app,
      workspaces: [app],
      port: " ",
    })).toBe("clanky preview --workspace 'My App' --port 3000");
  });

  test("sanitizes invalid preview ports before building the CLI command", () => {
    const app = workspace("workspace-1", "App");

    expect(buildPreviewCliCommand({
      workspace: app,
      workspaces: [app],
      port: "3000; rm -rf /",
    })).toBe("clanky preview --workspace App --port 3000");

    expect(buildPreviewCliCommand({
      workspace: app,
      workspaces: [app],
      port: "1e3",
    })).toBe("clanky preview --workspace App --port 3000");
  });

});
