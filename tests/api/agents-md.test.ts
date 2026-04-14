/**
 * API integration tests for AGENTS.md optimization endpoints.
 * Tests use actual HTTP requests to a test server.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { serve, type Server } from "bun";
import { apiRoutes } from "../../src/api";
import { ensureDataDirectories } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import { createMockBackend } from "../mocks/mock-backend";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { RALPHER_OPTIMIZATION_VERSION } from "../../src/core/agents-md-optimizer";

describe("AGENTS.md API Integration", () => {
  let testDataDir: string;
  let testWorkDir: string;
  let server: Server<unknown>;
  let baseUrl: string;

  beforeAll(async () => {
    // Create temp directories
    testDataDir = await mkdtemp(join(tmpdir(), "ralpher-api-agentsmd-test-data-"));
    testWorkDir = await mkdtemp(join(tmpdir(), "ralpher-api-agentsmd-test-work-"));

    // Set env var for persistence
    process.env["RALPHER_DATA_DIR"] = testDataDir;
    await ensureDataDirectories();

    // Initialize git repo
    await Bun.$`git init ${testWorkDir}`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.name "Test User"`.quiet();
    await Bun.$`touch ${testWorkDir}/README.md`.quiet();
    await Bun.$`git -C ${testWorkDir} add .`.quiet();
    await Bun.$`git -C ${testWorkDir} commit -m "Initial commit"`.quiet();

    // Set up backend manager with test executor
    backendManager.setBackendForTesting(createMockBackend());
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    // Start test server
    server = serve({
      port: 0,
      routes: { ...apiRoutes },
    });
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    server.stop();
    backendManager.resetForTesting();
    await rm(testDataDir, { recursive: true, force: true });
    await rm(testWorkDir, { recursive: true, force: true });
    delete process.env["RALPHER_DATA_DIR"];
  });

  // Clean up workspaces before each test and remove AGENTS.md
  beforeEach(async () => {
    const { getDatabase } = await import("../../src/persistence/database");
    const db = getDatabase();
    db.run("DELETE FROM loops WHERE workspace_id IS NOT NULL");
    db.run("DELETE FROM workspaces");

    // Remove AGENTS.md if it exists
    const agentsMdPath = join(testWorkDir, "AGENTS.md");
    await rm(agentsMdPath, { force: true });
  });

  /**
   * Helper to create a workspace and return its ID.
   */
  async function createTestWorkspace(): Promise<string> {
    const response = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Test Workspace",
        directory: testWorkDir,
        serverSettings: {
          agent: {
            provider: "opencode",
            transport: "stdio",
          },
        },
      }),
    });
    expect(response.ok).toBe(true);
    const data = await response.json();
    return data.id;
  }

  describe("GET /api/workspaces/:id/agents-md", () => {
    test("returns status for workspace without AGENTS.md", async () => {
      const workspaceId = await createTestWorkspace();

      const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/agents-md`);
      expect(response.ok).toBe(true);
      const data = await response.json();

      expect(data.content).toBe("");
      expect(data.fileExists).toBe(false);
      expect(data.analysis.isOptimized).toBe(false);
      expect(data.analysis.updateAvailable).toBe(true);
    });

    test("returns status for workspace with plain AGENTS.md", async () => {
      const workspaceId = await createTestWorkspace();

      // Create an AGENTS.md without Ralpher optimization
      await writeFile(join(testWorkDir, "AGENTS.md"), "# My Project\n\nGuidelines here.\n");

      const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/agents-md`);
      expect(response.ok).toBe(true);
      const data = await response.json();

      expect(data.content).toContain("# My Project");
      expect(data.fileExists).toBe(true);
      expect(data.analysis.isOptimized).toBe(false);
      expect(data.analysis.updateAvailable).toBe(true);
    });

    test("returns status for workspace with optimized AGENTS.md", async () => {
      const workspaceId = await createTestWorkspace();

      // Create an already-optimized AGENTS.md
      await writeFile(
        join(testWorkDir, "AGENTS.md"),
        `# My Project\n\n<!-- ralpher-optimized-v${RALPHER_OPTIMIZATION_VERSION} -->\n## Agentic Workflow\n`
      );

      const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/agents-md`);
      expect(response.ok).toBe(true);
      const data = await response.json();

      expect(data.fileExists).toBe(true);
      expect(data.analysis.isOptimized).toBe(true);
      expect(data.analysis.updateAvailable).toBe(false);
    });

    test("returns 404 for non-existent workspace", async () => {
      const response = await fetch(`${baseUrl}/api/workspaces/non-existent-id/agents-md`);
      expect(response.status).toBe(404);
    });
  });

  describe("POST /api/workspaces/:id/agents-md/preview", () => {
    test("returns preview for workspace without AGENTS.md", async () => {
      const workspaceId = await createTestWorkspace();

      const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/agents-md/preview`, {
        method: "POST",
      });
      expect(response.ok).toBe(true);
      const data = await response.json();

      expect(data.fileExists).toBe(false);
      expect(data.currentContent).toBe("");
      expect(data.analysis.isOptimized).toBe(false);
      expect(data.proposedContent).toContain("<!-- ralpher-optimized-v");
      expect(data.proposedContent).toContain("## Agentic Workflow");
      expect(data.ralpherSection).toContain("## Agentic Workflow");
    });

    test("returns preview for workspace with existing AGENTS.md", async () => {
      const workspaceId = await createTestWorkspace();
      await writeFile(join(testWorkDir, "AGENTS.md"), "# My Project\n\nExisting content.\n");

      const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/agents-md/preview`, {
        method: "POST",
      });
      expect(response.ok).toBe(true);
      const data = await response.json();

      expect(data.fileExists).toBe(true);
      expect(data.currentContent).toContain("# My Project");
      expect(data.proposedContent).toContain("# My Project");
      expect(data.proposedContent).toContain("<!-- ralpher-optimized-v");
    });

    test("returns 404 for non-existent workspace", async () => {
      const response = await fetch(`${baseUrl}/api/workspaces/non-existent-id/agents-md/preview`, {
        method: "POST",
      });
      expect(response.status).toBe(404);
    });
  });

  describe("POST /api/workspaces/:id/agents-md/optimize", () => {
    test("creates AGENTS.md when it doesn't exist", async () => {
      const workspaceId = await createTestWorkspace();

      const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/agents-md/optimize`, {
        method: "POST",
      });
      expect(response.ok).toBe(true);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.alreadyOptimized).toBe(false);
      expect(data.content).toContain("<!-- ralpher-optimized-v");
      expect(data.content).toContain("## Agentic Workflow");

      // Verify the file was actually written
      const agentsMdPath = join(testWorkDir, "AGENTS.md");
      const fileContent = await Bun.file(agentsMdPath).text();
      expect(fileContent).toContain("<!-- ralpher-optimized-v");
    });

    test("appends optimization to existing AGENTS.md", async () => {
      const workspaceId = await createTestWorkspace();
      const existingContent = "# My Project\n\nExisting guidelines.\n";
      await writeFile(join(testWorkDir, "AGENTS.md"), existingContent);

      const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/agents-md/optimize`, {
        method: "POST",
      });
      expect(response.ok).toBe(true);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.alreadyOptimized).toBe(false);
      expect(data.content).toContain("# My Project");
      expect(data.content).toContain("<!-- ralpher-optimized-v");

      // Verify the file on disk
      const fileContent = await Bun.file(join(testWorkDir, "AGENTS.md")).text();
      expect(fileContent).toContain("# My Project");
      expect(fileContent).toContain("<!-- ralpher-optimized-v");
    });

    test("returns alreadyOptimized when current version present", async () => {
      const workspaceId = await createTestWorkspace();
      const optimizedContent = `# My Project\n\n<!-- ralpher-optimized-v${RALPHER_OPTIMIZATION_VERSION} -->\n## Agentic Workflow — Planning & Progress Tracking\n\nContent.\n`;
      await writeFile(join(testWorkDir, "AGENTS.md"), optimizedContent);

      const response = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/agents-md/optimize`, {
        method: "POST",
      });
      expect(response.ok).toBe(true);
      const data = await response.json();

      expect(data.success).toBe(true);
      expect(data.alreadyOptimized).toBe(true);
    });

    test("is idempotent — second optimize call doesn't duplicate", async () => {
      const workspaceId = await createTestWorkspace();
      await writeFile(join(testWorkDir, "AGENTS.md"), "# My Project\n\nGuidelines.\n");

      // First optimize
      const response1 = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/agents-md/optimize`, {
        method: "POST",
      });
      expect(response1.ok).toBe(true);
      const data1 = await response1.json();
      expect(data1.success).toBe(true);
      expect(data1.alreadyOptimized).toBe(false);

      // Second optimize — should be a no-op
      const response2 = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/agents-md/optimize`, {
        method: "POST",
      });
      expect(response2.ok).toBe(true);
      const data2 = await response2.json();
      expect(data2.success).toBe(true);
      expect(data2.alreadyOptimized).toBe(true);

      // Verify only one marker exists
      const fileContent = await Bun.file(join(testWorkDir, "AGENTS.md")).text();
      const markerCount = (fileContent.match(/<!-- ralpher-optimized-v/g) || []).length;
      expect(markerCount).toBe(1);
    });

    test("returns 404 for non-existent workspace", async () => {
      const response = await fetch(`${baseUrl}/api/workspaces/non-existent-id/agents-md/optimize`, {
        method: "POST",
      });
      expect(response.status).toBe(404);
    });
  });
});
