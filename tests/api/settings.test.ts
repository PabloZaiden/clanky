/**
 * API integration tests for destructive settings maintenance operations.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type Server } from "bun";
import { serveNativeApiRoutes } from "../native-api-server";
import {
  setupTestContext,
  teardownTestContext,
  testModel,
  testWorkspaceId,
  type TestContext,
} from "../setup";
import { getCurrentBranch } from "../helpers/git-fixtures";

describe("Settings API integration", () => {
  let context: TestContext;
  let server: Server<unknown>;
  let baseUrl: string;

  beforeEach(async () => {
    context = await setupTestContext({ initGit: true });
    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterEach(async () => {
    server.stop();
    await teardownTestContext(context);
  });

  test("resets the database before returning success", async () => {
    const beforeResponse = await fetch(`${baseUrl}/api/workspaces`);
    expect(beforeResponse.status).toBe(200);
    expect(await beforeResponse.json()).toHaveLength(1);

    const resetResponse = await fetch(`${baseUrl}/api/settings/reset-all`, {
      method: "POST",
    });
    expect(resetResponse.status).toBe(200);
    expect(await resetResponse.json()).toMatchObject({
      success: true,
      message: "All settings have been reset. Database recreated.",
    });

    const afterResponse = await fetch(`${baseUrl}/api/workspaces`);
    expect(afterResponse.status).toBe(200);
    expect(await afterResponse.json()).toEqual([]);
  });

  test("purges terminal tasks across workspaces without deleting active tasks", async () => {
    const baseBranch = await getCurrentBranch(context.workDir);
    const createWorkspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Second Purge Workspace",
        directory: context.workDir,
        serverSettings: { agent: { provider: "opencode", transport: "stdio" } },
      }),
    });
    expect(createWorkspaceResponse.status).toBe(201);
    const secondWorkspace = await createWorkspaceResponse.json() as { id: string };

    async function createDraftTask(workspaceId: string, name: string): Promise<string> {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          prompt: "Purge selection fixture",
          name,
          attachments: [],
          model: testModel,
          cheapModel: { mode: "same-as-task" },
          maxIterations: null,
          maxConsecutiveErrors: 10,
          activityTimeoutSeconds: 300,
          stopPattern: "<promise>COMPLETE</promise>$",
          git: { branchPrefix: "", commitScope: "" },
          baseBranch,
          useWorktree: true,
          clearPlanningFolder: false,
          planMode: false,
          autoAcceptPlan: false,
          fullyAutonomous: false,
          draft: true,
        }),
      });
      expect(response.status).toBe(201);
      return (await response.json()).config.id;
    }

    const archivedInDefault = await createDraftTask(testWorkspaceId, "Archived in default");
    const activeInDefault = await createDraftTask(testWorkspaceId, "Active in default");
    const archivedInSecond = await createDraftTask(secondWorkspace.id, "Archived in second");

    for (const taskId of [archivedInDefault, archivedInSecond]) {
      const deleteResponse = await fetch(`${baseUrl}/api/tasks/${taskId}`, { method: "DELETE" });
      expect(deleteResponse.status).toBe(200);
    }

    const purgeResponse = await fetch(`${baseUrl}/api/settings/purge-terminal-tasks`, {
      method: "POST",
    });
    expect(purgeResponse.status).toBe(200);
    const purgeBody = await purgeResponse.json();

    expect(purgeBody.success).toBe(true);
    expect(purgeBody.totalWorkspaces).toBe(2);
    expect(purgeBody.totalArchived).toBe(2);
    expect(purgeBody.purgedCount).toBe(2);
    expect(new Set(purgeBody.purgedTaskIds)).toEqual(
      new Set([archivedInDefault, archivedInSecond]),
    );
    expect(purgeBody.failures).toEqual([]);

    expect((await fetch(`${baseUrl}/api/tasks/${archivedInDefault}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/tasks/${archivedInSecond}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/tasks/${activeInDefault}`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/workspaces/${testWorkspaceId}`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/api/workspaces/${secondWorkspace.id}`)).status).toBe(200);
  });
});
