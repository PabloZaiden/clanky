import { describe, expect, test } from "bun:test";
import type { Workspace } from "@ralpher/shared";
import { CommandFactory } from "../../apps/tui/src/services/command-factory";
import { EntityCache } from "../../apps/tui/src/services/entity-cache";

describe("tui command factory", () => {
  test("workspace edit options omit directory because updates do not persist it", () => {
    const factory = new CommandFactory(
      {} as never,
      new EntityCache(),
    );
    const getWorkspaceUpdateOptions = (factory as unknown as {
      getWorkspaceUpdateOptions: (workspace: Workspace) => Record<string, unknown>;
    }).getWorkspaceUpdateOptions.bind(factory);

    const options = getWorkspaceUpdateOptions({
      id: "workspace-1",
      name: "Demo",
      directory: "/workspaces/demo",
      serverSettings: {
        agent: {
          provider: "copilot",
          transport: "ssh",
          hostname: "devbox",
          port: 22,
        },
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(options).not.toHaveProperty("directory");
    expect(options).toHaveProperty("name");
    expect(options).toHaveProperty("hostname");
  });
});
