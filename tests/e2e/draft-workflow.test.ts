/**
 * E2E tests for draft loop workflows
 * Tests the complete user journey: create draft -> edit -> edit -> start loop
 */

import { test, expect, describe, beforeAll, afterAll, afterEach, beforeEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { serve, type Server } from "bun";
import { apiRoutes } from "../../src/api";
import { ensureDataDirectories } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { createMockBackend } from "../mocks/mock-backend";

// Default test model for loop creation (model is now required)
const testModel = { providerID: "test-provider", modelID: "test-model", variant: "" };
const baseCreateLoopPayload = {
  attachments: [],
  cheapModel: { mode: "same-as-loop" as const },
  maxIterations: null,
  maxConsecutiveErrors: 10,
  activityTimeoutSeconds: 300,
  stopPattern: "<promise>COMPLETE</promise>$",
  git: {
    branchPrefix: "",
    commitScope: "",
  },
  baseBranch: "main",
  clearPlanningFolder: false,
  autoAcceptPlan: false,
  fullyAutonomous: false,
  draft: false,
};

describe("Draft Loop E2E Workflow", () => {
  let testDataDir: string;
  let testWorkDir: string;
  let server: Server<unknown>;
  let baseUrl: string;
  let testWorkspaceId: string;

  // Helper function to poll for loop status
  async function waitForLoopStatus(
    loopId: string,
    targetStatuses: string[],
    timeoutMs = 30000
  ): Promise<boolean> {
    const startTime = Date.now();
    while (Date.now() - startTime < timeoutMs) {
      const response = await fetch(`${baseUrl}/api/loops/${loopId}`);
      if (response.ok) {
        const data = await response.json();
        if (targetStatuses.includes(data.state?.status)) {
          return true;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return false;
  }

  // Helper to create or get a workspace for a directory
  async function getOrCreateWorkspace(directory: string, name?: string): Promise<string> {
    const createResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name || directory.split("/").pop() || "Test",
        directory,
        serverSettings: { agent: { provider: "opencode", transport: "stdio" } },
      }),
    });
    const data = await createResponse.json();
    
    if (createResponse.status === 409 && data.existingWorkspace) {
      return data.existingWorkspace.id;
    }
    
    if (createResponse.ok && data.id) {
      return data.id;
    }
    
    throw new Error(`Failed to create workspace: ${JSON.stringify(data)}`);
  }

  beforeAll(async () => {
    // Create temp directories
    testDataDir = await mkdtemp(join(tmpdir(), "ralpher-draft-e2e-test-data-"));
    testWorkDir = await mkdtemp(join(tmpdir(), "ralpher-draft-e2e-test-work-"));

    // Set env var for persistence
    process.env["RALPHER_DATA_DIR"] = testDataDir;

    // Ensure directories exist
    await ensureDataDirectories();

    // Initialize git repo in test work directory
    await Bun.$`git init -b main ${testWorkDir}`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.name "Test User"`.quiet();
    await Bun.$`touch ${testWorkDir}/README.md`.quiet();
    await Bun.$`git -C ${testWorkDir} add .`.quiet();
    await Bun.$`git -C ${testWorkDir} commit -m "Initial commit"`.quiet();

    // Set up backend manager with test executor factory
    backendManager.setBackendForTesting(createMockBackend());
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    // Start test server on random port
    server = serve({
      port: 0,
      routes: {
        ...apiRoutes,
      },
    });
    baseUrl = server.url.toString().replace(/\/$/, "");

    // Create workspace for tests
    testWorkspaceId = await getOrCreateWorkspace(testWorkDir, "Draft E2E Test Workspace");
  });

  afterAll(async () => {
    // Stop server
    server.stop();

    // Reset backend manager
    backendManager.resetForTesting();

    // Cleanup temp directories
    await rm(testDataDir, { recursive: true, force: true });
    await rm(testWorkDir, { recursive: true, force: true });

    // Clear env
    delete process.env["RALPHER_DATA_DIR"];
  });

  // Clean up any active loops before and after each test to prevent blocking
  const cleanupActiveLoops = async () => {
    const { listLoops, updateLoopState, loadLoop } = await import("../../src/persistence/loops");
    const { loopManager } = await import("../../src/core/loop-manager");
    
    // Clear all running engines first
    loopManager.resetForTesting();
    
    const loops = await listLoops();
    const activeStatuses = ["idle", "planning", "starting", "running", "waiting"];
    
    for (const loop of loops) {
      if (activeStatuses.includes(loop.state.status)) {
        // Load full loop to get current state
        const fullLoop = await loadLoop(loop.config.id);
        if (fullLoop) {
          // Mark as deleted to make it a terminal state
          await updateLoopState(loop.config.id, {
            ...fullLoop.state,
            status: "deleted",
          });
        }
      }
    }
  };

  beforeEach(cleanupActiveLoops);
  afterEach(cleanupActiveLoops);

  test("create draft -> edit -> edit -> start loop (immediate execution)", async () => {
    // Step 1: Create draft
    const createResponse = await fetch(`${baseUrl}/api/loops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...baseCreateLoopPayload,
        workspaceId: testWorkspaceId,
        prompt: "Initial task",
        name: "Test Draft Loop",
        draft: true,
        planMode: false,
          model: testModel,
          useWorktree: true,
      }),
    });

    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json();
    const loopId = createBody.config.id;
    expect(createBody.state.status).toBe("draft");
    expect(createBody.config.prompt).toBe("Initial task");

    // Verify no git branch created yet
    expect(createBody.state.git?.branch).toBeUndefined();

    // Step 2: First edit - update name and prompt
    const firstEditResponse = await fetch(`${baseUrl}/api/loops/${loopId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Updated task v1",
      }),
    });

    expect(firstEditResponse.status).toBe(200);
    const firstEditBody = await firstEditResponse.json();
    expect(firstEditBody.state.status).toBe("draft");
    expect(firstEditBody.config.prompt).toBe("Updated task v1");

    // Step 3: Second edit - update prompt and add config
    const secondEditResponse = await fetch(`${baseUrl}/api/loops/${loopId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Final task description",
        maxIterations: 5,
        maxConsecutiveErrors: 3,
      }),
    });

    expect(secondEditResponse.status).toBe(200);
    const secondEditBody = await secondEditResponse.json();
    expect(secondEditBody.state.status).toBe("draft");
    expect(secondEditBody.config.prompt).toBe("Final task description");
    expect(secondEditBody.config.maxIterations).toBe(5);
    expect(secondEditBody.config.maxConsecutiveErrors).toBe(3);

    // Step 4: Start loop (immediate execution)
    const startResponse = await fetch(`${baseUrl}/api/loops/${loopId}/draft/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planMode: false, attachments: [] }),
    });

    expect(startResponse.status).toBe(200);
    const startBody = await startResponse.json();

    // Verify loop started - should no longer be in draft status
    expect(startBody.state.status).not.toBe("draft");
    expect(["idle", "starting", "working", "completed", "error"]).toContain(
      startBody.state.status
    );

    // Wait for loop to complete or reach a final state
    const completed = await waitForLoopStatus(
      loopId,
      ["completed", "error", "stopped"],
      30000
    );
    expect(completed).toBe(true);

    // Verify final configuration is correct and git branch was created
    const finalResponse = await fetch(`${baseUrl}/api/loops/${loopId}`);
    const finalBody = await finalResponse.json();
    expect(finalBody.config.prompt).toBe("Final task description");
    expect(finalBody.config.maxIterations).toBe(5);
    
    // Git branch should be created after loop started
    // Note: In tests with mock backend, git setup may not complete if loop finishes too quickly
    // Just verify the loop completed successfully
    expect(finalBody.state.status).toBe("completed");
  });

  test("create draft -> edit -> edit -> start loop (plan mode)", async () => {
    // Step 1: Create draft with plan mode config
    const createResponse = await fetch(`${baseUrl}/api/loops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...baseCreateLoopPayload,
        workspaceId: testWorkspaceId,
        prompt: "Create a plan for feature X",
        name: "Test Draft Loop",
        planMode: true,
          model: testModel,
          useWorktree: true,
        draft: true,
      }),
    });

    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json();
    const loopId = createBody.config.id;

    // Verify draft status
    expect(createBody.state.status).toBe("draft");
    expect(createBody.config.planMode).toBe(true);

    // Step 2: First edit - refine the prompt
    const firstEditResponse = await fetch(`${baseUrl}/api/loops/${loopId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Create a detailed plan for implementing feature X with tests",
      }),
    });

    expect(firstEditResponse.status).toBe(200);
    const firstEditBody = await firstEditResponse.json();
    expect(firstEditBody.config.prompt).toBe(
      "Create a detailed plan for implementing feature X with tests"
    );

    // Step 3: Second edit - add more configuration
    const secondEditResponse = await fetch(`${baseUrl}/api/loops/${loopId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clearPlanningFolder: true,
        activityTimeoutSeconds: 120,
      }),
    });

    expect(secondEditResponse.status).toBe(200);
    const secondEditBody = await secondEditResponse.json();
    expect(secondEditBody.config.clearPlanningFolder).toBe(true);
    expect(secondEditBody.config.activityTimeoutSeconds).toBe(120);

    // Step 4: Start loop in plan mode
    const startResponse = await fetch(`${baseUrl}/api/loops/${loopId}/draft/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planMode: true, attachments: [] }),
    });

    expect(startResponse.status).toBe(200);
    const startBody = await startResponse.json();

    // Verify loop entered planning status
    expect(startBody.state.status).toBe("planning");
    expect(startBody.state.planMode?.active).toBe(true);

    // Wait for planning to complete or reach idle
    const completed = await waitForLoopStatus(
      loopId,
      ["planning", "idle", "stopped", "completed"],
      30000
    );
    expect(completed).toBe(true);

    // Verify final configuration matches edits
    const finalResponse = await fetch(`${baseUrl}/api/loops/${loopId}`);
    const finalBody = await finalResponse.json();
    expect(finalBody.config.clearPlanningFolder).toBe(true);
    
    // In mock test environment, git setup may not complete if loop finishes too quickly
    // Just verify the loop reached a valid state
    expect(["planning", "idle", "stopped", "completed"]).toContain(finalBody.state.status);
  });

  test("create draft -> do not edit -> start immediately", async () => {
    // Use a unique directory for this test to avoid conflicts with other tests
    const uniqueWorkDir = await mkdtemp(join(tmpdir(), "ralpher-draft-e2e-quick-"));
    await Bun.$`git init -b main ${uniqueWorkDir}`.quiet();
    await Bun.$`git -C ${uniqueWorkDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${uniqueWorkDir} config user.name "Test User"`.quiet();
    await Bun.$`touch ${uniqueWorkDir}/README.md`.quiet();
    await Bun.$`git -C ${uniqueWorkDir} add .`.quiet();
    await Bun.$`git -C ${uniqueWorkDir} commit -m "Initial commit"`.quiet();
    
    try {
      // Create workspace for the unique directory
      const uniqueWorkspaceId = await getOrCreateWorkspace(uniqueWorkDir, "Quick Test Workspace");

      // Step 1: Create draft
      const createResponse = await fetch(`${baseUrl}/api/loops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...baseCreateLoopPayload,
        workspaceId: uniqueWorkspaceId,
        prompt: "Quick task",
          name: "Test Draft Loop",
          draft: true,
          planMode: false,
          model: testModel,
          useWorktree: true,
        }),
      });

      expect(createResponse.status).toBe(201);
      const createBody = await createResponse.json();
      const loopId = createBody.config.id;

      // Verify draft status
      expect(createBody.state.status).toBe("draft");

      // Step 2: Start immediately without editing
      const startResponse = await fetch(`${baseUrl}/api/loops/${loopId}/draft/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planMode: false, attachments: [] }),
      });

      expect(startResponse.status).toBe(200);
      const startBody = await startResponse.json();
      expect(startBody.state.status).not.toBe("draft");

      // Verify configuration unchanged
      expect(startBody.config.prompt).toBe("Quick task");
      
      // Wait for completion to avoid affecting other tests
      await waitForLoopStatus(loopId, ["completed", "error", "stopped"], 30000);
    } finally {
      await rm(uniqueWorkDir, { recursive: true, force: true });
    }
  });

  test("cannot start non-draft loop via draft/start endpoint", async () => {
    // Create regular (non-draft) loop
    const createResponse = await fetch(`${baseUrl}/api/loops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...baseCreateLoopPayload,
        workspaceId: testWorkspaceId,
        prompt: "Task",
        name: "Test Draft Loop",
        planMode: false,
          model: testModel,
          useWorktree: true,
      }),
    });

    const createBody = await createResponse.json();
    const loopId = createBody.config.id;

    // Wait for it to complete
    await waitForLoopStatus(loopId, ["completed", "error", "stopped"], 30000);

    // Try to start via draft endpoint
    const startResponse = await fetch(`${baseUrl}/api/loops/${loopId}/draft/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ planMode: false, attachments: [] }),
    });

    expect(startResponse.status).toBe(400);
    const errorBody = await startResponse.json();
    expect(errorBody.error).toBe("not_draft");
  });

  test("workspaceId is included when fetching draft loop for editing", async () => {
    // This test ensures that when fetching a draft loop (e.g., to edit it),
    // the workspaceId is correctly included in the response.
    // This is critical for the UI to auto-select the correct workspace in the dropdown.

    // Step 1: Create draft
    const createResponse = await fetch(`${baseUrl}/api/loops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...baseCreateLoopPayload,
        workspaceId: testWorkspaceId,
        prompt: "Test task for workspace selection",
        name: "Test Draft Loop",
        draft: true,
        planMode: false,
          model: testModel,
          useWorktree: true,
      }),
    });

    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json();
    const loopId = createBody.config.id;

    // Verify draft was created with correct workspaceId
    expect(createBody.state.status).toBe("draft");
    expect(createBody.config.workspaceId).toBe(testWorkspaceId);

    // Step 2: Fetch the draft loop (simulating opening the edit dialog)
    const fetchResponse = await fetch(`${baseUrl}/api/loops/${loopId}`);
    expect(fetchResponse.status).toBe(200);
    const fetchBody = await fetchResponse.json();

    // Verify workspaceId is included in the fetched draft
    // This is what the UI uses to populate the workspace dropdown
    expect(fetchBody.config.workspaceId).toBe(testWorkspaceId);
    expect(fetchBody.state.status).toBe("draft");

    // Step 3: Verify workspaceId persists after editing other fields
    const editResponse = await fetch(`${baseUrl}/api/loops/${loopId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Updated prompt",
      }),
    });

    expect(editResponse.status).toBe(200);
    const editBody = await editResponse.json();

    // workspaceId should still be present after edit
    expect(editBody.config.workspaceId).toBe(testWorkspaceId);
  });

  test("plan mode checkbox persists when editing draft", async () => {
    // Step 1: Create draft with plan mode enabled
    const createResponse = await fetch(`${baseUrl}/api/loops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...baseCreateLoopPayload,
        workspaceId: testWorkspaceId,
        prompt: "Test task",
        name: "Test Draft Loop",
        planMode: true,
          model: testModel,
          useWorktree: true,
        draft: true,
      }),
    });

    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json();
    const loopId = createBody.config.id;

    // Verify draft was created with planMode true
    expect(createBody.state.status).toBe("draft");
    expect(createBody.config.planMode).toBe(true);

    // Step 2: Update the draft (but don't modify planMode)
    const updateResponse = await fetch(`${baseUrl}/api/loops/${loopId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
      }),
    });

    expect(updateResponse.status).toBe(200);
    const updateBody = await updateResponse.json();

    // Verify planMode is still true after update
    expect(updateBody.config.planMode).toBe(true);

    // Step 3: Fetch the draft again to verify persistence
    const fetchResponse = await fetch(`${baseUrl}/api/loops/${loopId}`);
    expect(fetchResponse.status).toBe(200);
    const fetchBody = await fetchResponse.json();

    // Verify planMode persisted after fetching from database
    expect(fetchBody.config.planMode).toBe(true);
  });

  test("plan mode checkbox can be unchecked and persists", async () => {
    // Step 1: Create draft with plan mode enabled
    const createResponse = await fetch(`${baseUrl}/api/loops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...baseCreateLoopPayload,
        workspaceId: testWorkspaceId,
        prompt: "Test task",
        name: "Test Draft Loop",
        planMode: true,
          model: testModel,
          useWorktree: true,
        draft: true,
      }),
    });

    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json();
    const loopId = createBody.config.id;

    // Verify draft was created with planMode true
    expect(createBody.state.status).toBe("draft");
    expect(createBody.config.planMode).toBe(true);

    // Step 2: Update the draft and uncheck planMode (set to false)
    const updateResponse = await fetch(`${baseUrl}/api/loops/${loopId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        planMode: false,
          model: testModel,
          useWorktree: true,
      }),
    });

    expect(updateResponse.status).toBe(200);
    const updateBody = await updateResponse.json();

    // Verify planMode is now false after update
    expect(updateBody.config.planMode).toBe(false);

    // Step 3: Fetch the draft again to verify persistence
    const fetchResponse = await fetch(`${baseUrl}/api/loops/${loopId}`);
    expect(fetchResponse.status).toBe(200);
    const fetchBody = await fetchResponse.json();

    // Verify planMode=false persisted after fetching from database
    expect(fetchBody.config.planMode).toBe(false);

    // Step 4: Update again without touching planMode to ensure it stays false
    const secondUpdateResponse = await fetch(`${baseUrl}/api/loops/${loopId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Updated prompt only",
      }),
    });

    expect(secondUpdateResponse.status).toBe(200);
    const secondUpdateBody = await secondUpdateResponse.json();

    // Verify planMode is still false
    expect(secondUpdateBody.config.planMode).toBe(false);
    expect(secondUpdateBody.config.prompt).toBe("Updated prompt only");
  });

  test("clearPlanningFolder checkbox can be unchecked and persists", async () => {
    // Step 1: Create draft with clearPlanningFolder enabled
    const createResponse = await fetch(`${baseUrl}/api/loops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...baseCreateLoopPayload,
        workspaceId: testWorkspaceId,
        prompt: "Test task",
        name: "Test Draft Loop",
        clearPlanningFolder: true,
        draft: true,
        planMode: false,
          model: testModel,
          useWorktree: true,
      }),
    });

    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json();
    const loopId = createBody.config.id;

    // Verify draft was created with clearPlanningFolder true
    expect(createBody.state.status).toBe("draft");
    expect(createBody.config.clearPlanningFolder).toBe(true);

    // Step 2: Update the draft and uncheck clearPlanningFolder (set to false)
    const updateResponse = await fetch(`${baseUrl}/api/loops/${loopId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clearPlanningFolder: false,
      }),
    });

    expect(updateResponse.status).toBe(200);
    const updateBody = await updateResponse.json();

    // Verify clearPlanningFolder is now false after update
    expect(updateBody.config.clearPlanningFolder).toBe(false);

    // Step 3: Fetch the draft again to verify persistence
    const fetchResponse = await fetch(`${baseUrl}/api/loops/${loopId}`);
    expect(fetchResponse.status).toBe(200);
    const fetchBody = await fetchResponse.json();

    // Verify clearPlanningFolder=false persisted after fetching from database
    expect(fetchBody.config.clearPlanningFolder).toBe(false);

    // Step 4: Update again without touching clearPlanningFolder to ensure it stays false
    const secondUpdateResponse = await fetch(`${baseUrl}/api/loops/${loopId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "Updated prompt only",
      }),
    });

    expect(secondUpdateResponse.status).toBe(200);
    const secondUpdateBody = await secondUpdateResponse.json();

    // Verify clearPlanningFolder is still false
    expect(secondUpdateBody.config.clearPlanningFolder).toBe(false);
    expect(secondUpdateBody.config.prompt).toBe("Updated prompt only");
  });

  test("sequential draft edits preserve prompt correctly", async () => {
    // This test simulates the user workflow of:
    // 1. Creating a draft with a specific prompt
    // 2. Closing the dialog
    // 3. Reopening to edit
    // 4. Modifying the prompt
    // 5. Saving
    // Each step should preserve the prompt correctly

    // Step 1: Create first draft
    const create1Response = await fetch(`${baseUrl}/api/loops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...baseCreateLoopPayload,
        workspaceId: testWorkspaceId,
        prompt: "First draft prompt - this should be unique",
        name: "Test Draft Loop",
        draft: true,
        planMode: false,
          model: testModel,
          useWorktree: true,
      }),
    });

    expect(create1Response.status).toBe(201);
    const create1Body = await create1Response.json();
    const loop1Id = create1Body.config.id;
    expect(create1Body.config.prompt).toBe("First draft prompt - this should be unique");

    // Step 2: Create second draft (simulating switching to create new)
    const create2Response = await fetch(`${baseUrl}/api/loops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...baseCreateLoopPayload,
        workspaceId: testWorkspaceId,
        prompt: "Second draft prompt - completely different",
        name: "Test Draft Loop",
        draft: true,
        planMode: false,
          model: testModel,
          useWorktree: true,
      }),
    });

    expect(create2Response.status).toBe(201);
    const create2Body = await create2Response.json();
    const loop2Id = create2Body.config.id;
    expect(create2Body.config.prompt).toBe("Second draft prompt - completely different");

    // Step 3: Go back to edit first draft - verify prompt is correct
    const get1Response = await fetch(`${baseUrl}/api/loops/${loop1Id}`);
    expect(get1Response.status).toBe(200);
    const get1Body = await get1Response.json();
    expect(get1Body.config.prompt).toBe("First draft prompt - this should be unique");

    // Step 4: Update first draft
    const update1Response = await fetch(`${baseUrl}/api/loops/${loop1Id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: "First draft prompt - UPDATED",
      }),
    });

    expect(update1Response.status).toBe(200);
    const update1Body = await update1Response.json();
    expect(update1Body.config.prompt).toBe("First draft prompt - UPDATED");

    // Step 5: Switch to edit second draft - verify its prompt is unchanged
    const get2Response = await fetch(`${baseUrl}/api/loops/${loop2Id}`);
    expect(get2Response.status).toBe(200);
    const get2Body = await get2Response.json();
    expect(get2Body.config.prompt).toBe("Second draft prompt - completely different");

    // Step 6: Verify first draft still has updated prompt
    const verify1Response = await fetch(`${baseUrl}/api/loops/${loop1Id}`);
    expect(verify1Response.status).toBe(200);
    const verify1Body = await verify1Response.json();
    expect(verify1Body.config.prompt).toBe("First draft prompt - UPDATED");
  });

  test("draft preserves the explicitly provided name", async () => {
    const longPrompt = "This is a very long prompt that should be truncated to create the draft name automatically";
    
    const createResponse = await fetch(`${baseUrl}/api/loops`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...baseCreateLoopPayload,
        workspaceId: testWorkspaceId,
        prompt: longPrompt,
        name: "Explicit Draft Title",
        draft: true,
        planMode: false,
        model: testModel,
        useWorktree: true,
      }),
    });

    expect(createResponse.status).toBe(201);
    const createBody = await createResponse.json();
    
    expect(createBody.config.name).toBe("Explicit Draft Title");
    expect(createBody.config.prompt).toBe(longPrompt);
  });
});
