/**
 * API integration tests for git endpoints.
 * Tests use actual HTTP requests to a test server with real git repos.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { type Server } from "bun";
import { serveNativeApiRoutes } from "../native-api-server";
import { ensureDataDirectories } from "../../src/persistence/database";
import { backendManager } from "../../src/core/backend-manager";
import { createMockBackend } from "../mocks/mock-backend";
import { TestCommandExecutor } from "../mocks/mock-executor";
import { createWorkspace } from "../../src/persistence/workspaces";
import { getDefaultServerSettings } from "@/shared/settings";

describe("Git API Integration", () => {
  let testDataDir: string;
  let testWorkDir: string;
  let server: Server<unknown>;
  let baseUrl: string;

  beforeAll(async () => {
    // Create temp directories
    testDataDir = await mkdtemp(join(tmpdir(), "clanky-api-git-test-data-"));
    testWorkDir = await mkdtemp(join(tmpdir(), "clanky-api-git-test-work-"));

    // Set env var for persistence
    process.env["CLANKY_DATA_DIR"] = testDataDir;
    await ensureDataDirectories();

    // Initialize git repo with a couple branches
    await Bun.$`git init ${testWorkDir}`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${testWorkDir} config user.name "Test User"`.quiet();
    await Bun.$`touch ${testWorkDir}/README.md`.quiet();
    await Bun.$`git -C ${testWorkDir} add .`.quiet();
    await Bun.$`git -C ${testWorkDir} commit -m "Initial commit"`.quiet();
    // Create a second branch
    await Bun.$`git -C ${testWorkDir} branch feature-branch`.quiet();
    await Bun.$`git -C ${testWorkDir} remote add origin git@github.com:owner/repo.git`.quiet();

    // Create workspace for test directory
    await createWorkspace({
      id: "git-test-workspace",
      name: "Git Test",
      directory: testWorkDir,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      serverSettings: getDefaultServerSettings(),
    });

    // Set up backend manager with test executor factory
    backendManager.setBackendForTesting(createMockBackend());
    backendManager.setExecutorFactoryForTesting(() => new TestCommandExecutor());

    // Start test server
    server = serveNativeApiRoutes();
    baseUrl = server.url.toString().replace(/\/$/, "");
  });

  afterAll(async () => {
    server.stop(true);
    await rm(testDataDir, { recursive: true, force: true });
    await rm(testWorkDir, { recursive: true, force: true });
  });

  // ==========================================================================
  // GET /api/git/branches
  // ==========================================================================

  describe("GET /api/git/branches", () => {
    test("returns branches for a valid workspace", async () => {
      const res = await fetch(`${baseUrl}/api/git/branches?workspaceId=git-test-workspace`);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.currentBranch).toBeTruthy();
      expect(Array.isArray(body.branches)).toBe(true);
      expect(body.branches.length).toBeGreaterThanOrEqual(2);

      // Should have the default branch and feature-branch
      const branchNames = body.branches.map((b: { name: string }) => b.name);
      expect(branchNames).toContain("feature-branch");
    });

    test("returns the current branch correctly", async () => {
      const res = await fetch(`${baseUrl}/api/git/branches?workspaceId=git-test-workspace`);
      const body = await res.json();

      // Current branch should match what's checked out
      const currentBranch = body.branches.find((b: { current: boolean }) => b.current);
      expect(currentBranch).toBeTruthy();
      expect(body.currentBranch).toBe(currentBranch.name);
    });

    test("returns 400 when workspaceId parameter is missing", async () => {
      const res = await fetch(`${baseUrl}/api/git/branches`);
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe("missing_workspace_id");
    });

    test("returns 404 for an unknown workspace", async () => {
      const res = await fetch(`${baseUrl}/api/git/branches?workspaceId=unknown-workspace`);
      expect(res.status).toBe(404);
    });

    test("uses workspaceId as the only workspace identity", async () => {
      const res = await fetch(
        `${baseUrl}/api/git/branches?workspaceId=git-test-workspace`
      );
      expect(res.status).toBe(200);
    });

    test("ignores a supplied directory query", async () => {
      const res = await fetch(
        `${baseUrl}/api/git/branches?directory=${encodeURIComponent("/tmp/another-directory")}&workspaceId=git-test-workspace`
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.currentBranch).toBeTruthy();
      expect(Array.isArray(body.branches)).toBe(true);
    });
  });

  // ==========================================================================
  // GET /api/git/default-branch
  // ==========================================================================

  describe("GET /api/git/default-branch", () => {
    test("returns a default branch for a valid workspace", async () => {
      const res = await fetch(
        `${baseUrl}/api/git/default-branch?workspaceId=git-test-workspace`
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.defaultBranch).toBeTruthy();
      expect(typeof body.defaultBranch).toBe("string");
    });

    test("returns 400 when workspaceId parameter is missing", async () => {
      const res = await fetch(`${baseUrl}/api/git/default-branch`);
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe("missing_workspace_id");
    });

    test("returns 404 for an unknown workspace", async () => {
      const res = await fetch(`${baseUrl}/api/git/default-branch?workspaceId=unknown-workspace`);
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/git/remote-status", () => {
    test("returns true when origin is configured", async () => {
      const res = await fetch(
        `${baseUrl}/api/git/remote-status?workspaceId=git-test-workspace`
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({
        remote: "origin",
        hasRemote: true,
      });
    });

    test("returns false when origin is not configured", async () => {
      await Bun.$`git -C ${testWorkDir} remote remove origin`.quiet();

      try {
        const res = await fetch(
          `${baseUrl}/api/git/remote-status?workspaceId=git-test-workspace`
        );
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body).toEqual({
          remote: "origin",
          hasRemote: false,
        });
      } finally {
        await Bun.$`git -C ${testWorkDir} remote add origin git@github.com:owner/repo.git`.quiet();
      }
    });

    test("returns 400 when workspaceId parameter is missing", async () => {
      const res = await fetch(`${baseUrl}/api/git/remote-status`);
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe("missing_workspace_id");
    });
  });

  describe("GET /api/git/github-repository-url", () => {
    test("returns a normalized GitHub URL from origin when workspace repoUrl is not set", async () => {
      const res = await fetch(
        `${baseUrl}/api/git/github-repository-url?workspaceId=git-test-workspace`
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({
        githubUrl: "https://github.com/owner/repo",
      });
    });

    test("prefers a persisted workspace repoUrl when available", async () => {
      await createWorkspace({
        id: "git-test-workspace-persisted",
        name: "Git Test Persisted",
        directory: testWorkDir,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        serverSettings: {
          agent: {
            provider: "opencode",
            transport: "ssh",
            hostname: "git-host.test",
            port: 22,
          },
        },
        repoUrl: "https://github.com/persisted/repo.git",
      });

      const res = await fetch(
        `${baseUrl}/api/git/github-repository-url?workspaceId=git-test-workspace-persisted`
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({
        githubUrl: "https://github.com/persisted/repo",
      });
    });

    test("returns null when an explicit persisted repoUrl is non-GitHub", async () => {
      await createWorkspace({
        id: "git-test-workspace-non-github-persisted",
        name: "Git Test Non-GitHub Persisted",
        directory: testWorkDir,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        serverSettings: {
          agent: {
            provider: "opencode",
            transport: "ssh",
            hostname: "git-host.test",
            port: 22,
          },
        },
        repoUrl: "https://gitlab.com/persisted/repo.git",
      });

      const res = await fetch(
        `${baseUrl}/api/git/github-repository-url?workspaceId=git-test-workspace-non-github-persisted`
      );
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({
        githubUrl: null,
      });
    });

    test("returns null for non-GitHub remotes", async () => {
      await Bun.$`git -C ${testWorkDir} remote set-url origin git@gitlab.com:owner/repo.git`.quiet();

      try {
        const res = await fetch(
          `${baseUrl}/api/git/github-repository-url?workspaceId=git-test-workspace`
        );
        expect(res.status).toBe(200);

        const body = await res.json();
        expect(body).toEqual({
          githubUrl: null,
        });
      } finally {
        await Bun.$`git -C ${testWorkDir} remote set-url origin git@github.com:owner/repo.git`.quiet();
      }
    });

    test("returns 400 when workspaceId parameter is missing", async () => {
      const res = await fetch(`${baseUrl}/api/git/github-repository-url`);
      expect(res.status).toBe(400);

      const body = await res.json();
      expect(body.error).toBe("missing_workspace_id");
    });
  });
});
