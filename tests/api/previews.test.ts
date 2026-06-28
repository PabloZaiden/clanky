import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, ensureDataDirectories, getDatabase, initializeDatabase } from "../../src/persistence/database";
import { createWorkspace } from "../../src/persistence/workspaces";
import { previewSessionManager } from "../../src/core/preview-session-manager";
import { runWithCurrentUser } from "../../src/core/user-context";
import type { Workspace } from "../../src/types";
import { seedTestOwnerUser, testOwnerUser } from "../setup";

function buildWorkspace(id: string, name: string): Workspace {
  const now = new Date().toISOString();
  return {
    id,
    name,
    directory: `/tmp/${id}`,
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

describe("workspace previews", () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "clanky-previews-data-"));
    process.env["CLANKY_DATA_DIR"] = dataDir;
    await ensureDataDirectories();
    await initializeDatabase();
    seedTestOwnerUser();
  });

  afterAll(async () => {
    closeDatabase();
    delete process.env["CLANKY_DATA_DIR"];
    await rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    getDatabase().run("DELETE FROM preview_sessions");
    getDatabase().run("DELETE FROM workspaces");
  });

  test("registers, lists, and closes a CLI-owned preview", async () => {
    await runWithCurrentUser(testOwnerUser, async () => {
      await createWorkspace(buildWorkspace("workspace-1", "App"));
      const { preview } = await previewSessionManager.registerCliPreview({
        workspace: "workspace-1",
        remoteHost: "127.0.0.1",
        remotePort: 3000,
        localHost: "127.0.0.1",
        localPort: 43123,
        localUrl: "http://127.0.0.1:43123/",
        initialPath: "dashboard",
        cliHostname: "devbox",
      });

      expect(preview.config.workspaceId).toBe("workspace-1");
      expect(preview.config.initialPath).toBe("/dashboard");
      expect(preview.state.status).toBe("active");

      const previews = await previewSessionManager.listWorkspacePreviews("workspace-1");
      expect(previews).toHaveLength(1);
      expect(previews[0]?.config.localUrl).toBe("http://127.0.0.1:43123/");

      expect(await previewSessionManager.closePreview(preview.config.id, "test close")).toBe(true);
      const closed = await previewSessionManager.getPreview(preview.config.id);
      expect(closed?.state.status).toBe("closed");
    });
  });

  test("resolves workspace by unique name and rejects ambiguous names", async () => {
    await runWithCurrentUser(testOwnerUser, async () => {
      await createWorkspace(buildWorkspace("workspace-1", "App"));
      await createWorkspace(buildWorkspace("workspace-2", "Duplicate"));
      await createWorkspace(buildWorkspace("workspace-3", "Duplicate"));

      expect((await previewSessionManager.resolveWorkspaceReference("App")).id).toBe("workspace-1");
      await expect(previewSessionManager.resolveWorkspaceReference("Duplicate")).rejects.toThrow("ambiguous");
    });
  });
});
