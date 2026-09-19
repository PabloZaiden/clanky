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
    executionTargetRevision: 1,
    executionHostBinding: {
      host: { kind: "local", nodeId: "test-local-node" },
      targetKey: "local:test",
      revision: 1,
    },
    serverSettings: {
      agent: {
        provider: "opencode",
      },
    },
    createdAt: now,
    updatedAt: now,
  };
}

describe("preview command suggestion", () => {
  test("quotes unsafe workspace references independently from port sanitization", () => {
    const app = workspace("workspace-1", "My App; echo unexpected");

    const command = buildPreviewCliCommand({
      workspace: app,
      workspaces: [app],
      port: "3000",
    });

    expect(command).toBe(
      "clanky preview --workspace 'My App; echo unexpected' --port 3000",
    );
  });

  test("sanitizes shell-sensitive preview port input", () => {
    const app = workspace("workspace-1", "App");

    const command = buildPreviewCliCommand({
      workspace: app,
      workspaces: [app],
      port: "3000; rm -rf /",
    });

    expect(command).toContain("--port 3000");
    expect(command).not.toContain("rm -rf");
  });
});
