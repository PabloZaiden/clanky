import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backendManager } from "../../src/core/backend-manager";
import { workspaceFileService } from "../../src/core/workspace-file-service";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { getDefaultServerSettings } from "../../src/types/settings";
import type { Workspace } from "../../src/types";

describe("workspace file service", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "ralpher-workspace-file-service-"));
    await mkdir(join(workDir, "nested"), { recursive: true });
    await writeFile(join(workDir, "nested", "index.ts"), "export const value = 1;\n");
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());
  });

  afterEach(async () => {
    backendManager.resetForTesting();
    await rm(workDir, { recursive: true, force: true });
  });

  test("allows relative paths when the workspace root is filesystem root", async () => {
    const workspace: Workspace = {
      id: "workspace-root",
      name: "Root Workspace",
      directory: "/",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      serverSettings: getDefaultServerSettings(),
    };

    const requestedPath = join(workDir, "nested", "index.ts").replace(/^\//, "");
    const response = await workspaceFileService.readFile(workspace, requestedPath);

    expect(response.file.path).toBe(requestedPath);
    expect(response.content).toContain("value = 1");
  });
});
