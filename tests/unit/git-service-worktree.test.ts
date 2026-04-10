/**
 * Unit tests for GitService worktree operations.
 * Tests createWorktree, removeWorktree, listWorktrees, pruneWorktrees,
 * worktreeExists, addWorktreeForExistingBranch, and ensureWorktreeExcluded.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, readFile, rm, symlink } from "fs/promises";
import { join } from "path";
import { GitService } from "../../src/core/git-service";
import { cleanupTempGitRepository, createTempGitRepository } from "../helpers/git-fixtures";
import { TestCommandExecutor } from "../mocks/mock-executor";

describe("GitService Worktree Operations", () => {
  let testDir: string;
  let git: GitService;

  beforeEach(async () => {
    // Resolve symlinks (macOS /var → /private/var) to match git's resolved paths
    testDir = await createTempGitRepository({
      prefix: "ralpher-worktree-test-",
      resolveRealpath: true,
      initialCommit: "empty",
    });
    const executor = new TestCommandExecutor();
    git = new GitService(executor);
  });

  afterEach(async () => {
    await cleanupTempGitRepository(testDir);
  });

  describe("createWorktree", () => {
    test("creates a worktree with a new branch", async () => {
      const worktreePath = join(testDir, ".ralph-worktrees", "test-loop-1");

      await git.createWorktree(testDir, worktreePath, "ralph/test-branch");

      // Verify worktree directory exists
      const exists = await Bun.file(join(worktreePath, ".git")).exists();
      expect(exists).toBe(true);

      // Verify the branch is checked out in the worktree
      const branch = (await Bun.$`git -C ${worktreePath} branch --show-current`.text()).trim();
      expect(branch).toBe("ralph/test-branch");
    });

    test("creates a worktree from a specific base branch", async () => {
      // Create a feature branch with a file
      await Bun.$`git -C ${testDir} checkout -b feature`.quiet();
      await Bun.$`git -C ${testDir} commit --allow-empty -m "Feature commit"`.quiet();
      const currentBranch = (await Bun.$`git -C ${testDir} branch --show-current`.text()).trim();
      expect(currentBranch).toBe("feature");

      // Go back to default branch
      const defaultBranch = (await Bun.$`git -C ${testDir} rev-parse --abbrev-ref HEAD`.text()).trim();
      await Bun.$`git -C ${testDir} checkout ${defaultBranch}`.quiet().nothrow();

      // Create worktree based on feature branch
      const worktreePath = join(testDir, ".ralph-worktrees", "loop-from-feature");
      await git.createWorktree(testDir, worktreePath, "ralph/from-feature", "feature");

      // Verify the worktree has the feature branch commit
      const log = (await Bun.$`git -C ${worktreePath} log --oneline -1`.text()).trim();
      expect(log).toContain("Feature commit");
    });

    test("adds .ralph-worktrees to .git/info/exclude", async () => {
      const worktreePath = join(testDir, ".ralph-worktrees", "test-exclude");

      await git.createWorktree(testDir, worktreePath, "ralph/exclude-test");

      // Read the exclude file
      const excludeContent = await readFile(join(testDir, ".git", "info", "exclude"), "utf-8");
      expect(excludeContent).toContain(".ralph-worktrees");
    });

    test("throws when branch already exists", async () => {
      // Create a branch first
      await Bun.$`git -C ${testDir} branch existing-branch`.quiet();

      const worktreePath = join(testDir, ".ralph-worktrees", "existing-test");

      await expect(
        git.createWorktree(testDir, worktreePath, "existing-branch")
      ).rejects.toThrow();
    });

    test("creates multiple worktrees with unique branches", async () => {
      const path1 = join(testDir, ".ralph-worktrees", "loop-1");
      const path2 = join(testDir, ".ralph-worktrees", "loop-2");

      await git.createWorktree(testDir, path1, "ralph/branch-1");
      await git.createWorktree(testDir, path2, "ralph/branch-2");

      // Verify both worktrees exist and have correct branches
      const branch1 = (await Bun.$`git -C ${path1} branch --show-current`.text()).trim();
      const branch2 = (await Bun.$`git -C ${path2} branch --show-current`.text()).trim();

      expect(branch1).toBe("ralph/branch-1");
      expect(branch2).toBe("ralph/branch-2");
    });
  });

  describe("addWorktreeForExistingBranch", () => {
    test("creates a worktree for an existing branch", async () => {
      // Create a branch
      await Bun.$`git -C ${testDir} branch existing-branch`.quiet();

      const worktreePath = join(testDir, ".ralph-worktrees", "reuse-test");
      await git.addWorktreeForExistingBranch(testDir, worktreePath, "existing-branch");

      // Verify worktree has the correct branch
      const branch = (await Bun.$`git -C ${worktreePath} branch --show-current`.text()).trim();
      expect(branch).toBe("existing-branch");
    });

    test("throws when branch does not exist", async () => {
      const worktreePath = join(testDir, ".ralph-worktrees", "nonexistent-test");

      await expect(
        git.addWorktreeForExistingBranch(testDir, worktreePath, "nonexistent-branch")
      ).rejects.toThrow();
    });
  });

  describe("removeWorktree", () => {
    test("removes an existing worktree", async () => {
      const worktreePath = join(testDir, ".ralph-worktrees", "to-remove");
      await git.createWorktree(testDir, worktreePath, "ralph/to-remove");

      // Verify it exists first
      expect(await Bun.file(join(worktreePath, ".git")).exists()).toBe(true);

      // Remove it
      await git.removeWorktree(testDir, worktreePath);

      // Verify directory is gone
      const executor = new TestCommandExecutor();
      expect(await executor.directoryExists(worktreePath)).toBe(false);
    });

    test("force-removes a worktree with uncommitted changes", async () => {
      const worktreePath = join(testDir, ".ralph-worktrees", "dirty-remove");
      await git.createWorktree(testDir, worktreePath, "ralph/dirty-remove");

      // Create an uncommitted file in the worktree
      await Bun.$`touch ${worktreePath}/dirty-file.txt`.quiet();
      await Bun.$`git -C ${worktreePath} add .`.quiet();

      // Non-force removal should fail
      await expect(
        git.removeWorktree(testDir, worktreePath)
      ).rejects.toThrow();

      // Force removal should succeed
      await git.removeWorktree(testDir, worktreePath, { force: true });

      const executor = new TestCommandExecutor();
      expect(await executor.directoryExists(worktreePath)).toBe(false);
    });

    test("throws when worktree path does not exist", async () => {
      const fakePath = join(testDir, ".ralph-worktrees", "nonexistent");

      await expect(
        git.removeWorktree(testDir, fakePath)
      ).rejects.toThrow();
    });
  });

  describe("listWorktrees", () => {
    test("lists the main worktree by default", async () => {
      const worktrees = await git.listWorktrees(testDir);

      // At minimum, the main repo is listed
      expect(worktrees.length).toBeGreaterThanOrEqual(1);
      expect(worktrees[0]!.path).toBe(testDir);
    });

    test("lists created worktrees", async () => {
      const path1 = join(testDir, ".ralph-worktrees", "wt-1");
      const path2 = join(testDir, ".ralph-worktrees", "wt-2");

      await git.createWorktree(testDir, path1, "ralph/wt-1");
      await git.createWorktree(testDir, path2, "ralph/wt-2");

      const worktrees = await git.listWorktrees(testDir);

      // Main + 2 worktrees
      expect(worktrees.length).toBe(3);

      const paths = worktrees.map(wt => wt.path);
      expect(paths).toContain(path1);
      expect(paths).toContain(path2);

      // Verify branches
      const wt1 = worktrees.find(wt => wt.path === path1);
      const wt2 = worktrees.find(wt => wt.path === path2);
      expect(wt1!.branch).toBe("ralph/wt-1");
      expect(wt2!.branch).toBe("ralph/wt-2");
    });

    test("shows correct branch after worktree removal", async () => {
      const worktreePath = join(testDir, ".ralph-worktrees", "wt-temp");
      await git.createWorktree(testDir, worktreePath, "ralph/wt-temp");

      let worktrees = await git.listWorktrees(testDir);
      expect(worktrees.length).toBe(2);

      await git.removeWorktree(testDir, worktreePath);

      worktrees = await git.listWorktrees(testDir);
      expect(worktrees.length).toBe(1);
      expect(worktrees[0]!.path).toBe(testDir);
    });
  });

  describe("worktreeExists", () => {
    test("returns true for an existing worktree", async () => {
      const worktreePath = join(testDir, ".ralph-worktrees", "exists-test");
      await git.createWorktree(testDir, worktreePath, "ralph/exists-test");

      const exists = await git.worktreeExists(testDir, worktreePath);
      expect(exists).toBe(true);
    });

    test("returns false for a non-existent worktree", async () => {
      const fakePath = join(testDir, ".ralph-worktrees", "no-such-worktree");
      const exists = await git.worktreeExists(testDir, fakePath);
      expect(exists).toBe(false);
    });

    test("returns false after worktree is removed", async () => {
      const worktreePath = join(testDir, ".ralph-worktrees", "removed-test");
      await git.createWorktree(testDir, worktreePath, "ralph/removed-test");

      expect(await git.worktreeExists(testDir, worktreePath)).toBe(true);

      await git.removeWorktree(testDir, worktreePath);

      expect(await git.worktreeExists(testDir, worktreePath)).toBe(false);
    });

    test("matches stale worktree metadata through a symlinked parent path", async () => {
      const physicalParent = join(testDir, "physical-worktrees");
      const symlinkParent = join(testDir, "symlink-worktrees");
      await mkdir(physicalParent, { recursive: true });
      await symlink(physicalParent, symlinkParent);

      const aliasedWorktreePath = join(symlinkParent, "stale-symlinked");
      const canonicalWorktreePath = join(physicalParent, "stale-symlinked");
      await mkdir(canonicalWorktreePath, { recursive: true });
      await rm(canonicalWorktreePath, { recursive: true, force: true });

      const originalListWorktrees = git.listWorktrees.bind(git);
      git.listWorktrees = async () => [
        { path: canonicalWorktreePath, head: "deadbeef", branch: "ralph/stale-symlinked" },
      ];

      try {
        expect(await git.worktreeExists(testDir, aliasedWorktreePath)).toBe(true);
      } finally {
        git.listWorktrees = originalListWorktrees;
      }
    });
  });

  describe("pruneWorktrees", () => {
    test("prunes stale worktree entries", async () => {
      const worktreePath = join(testDir, ".ralph-worktrees", "stale-test");
      await git.createWorktree(testDir, worktreePath, "ralph/stale-test");

      // Manually delete the worktree directory (simulating external deletion)
      await rm(worktreePath, { recursive: true, force: true });

      // Before pruning, the worktree entry may still exist in git metadata
      let worktrees = await git.listWorktrees(testDir);
      // Git may or may not still list it depending on version, but prune should not fail
      
      // Prune stale entries
      await git.pruneWorktrees(testDir);

      // After pruning, the stale entry should be gone
      worktrees = await git.listWorktrees(testDir);
      const afterPrune = worktrees.find(wt => wt.path === worktreePath);
      expect(afterPrune).toBeUndefined();
    });

    test("succeeds when there are no stale worktrees", async () => {
      // Should not throw
      await git.pruneWorktrees(testDir);
    });
  });

  describe("ensureWorktreeRemoved", () => {
    test("prunes stale worktree metadata when the directory was deleted externally", async () => {
      const worktreePath = join(testDir, ".ralph-worktrees", "externally-deleted");
      await git.createWorktree(testDir, worktreePath, "ralph/externally-deleted");

      await rm(worktreePath, { recursive: true, force: true });

      await git.ensureWorktreeRemoved(testDir, worktreePath, { force: true });

      const worktrees = await git.listWorktrees(testDir);
      expect(worktrees.find((wt) => wt.path === worktreePath)).toBeUndefined();
      expect(await git.worktreeExists(testDir, worktreePath)).toBe(false);
    });

    test("throws when a leftover worktree directory still exists after cleanup", async () => {
      const orphanPath = join(testDir, ".ralph-worktrees", "orphaned-directory");
      await Bun.$`mkdir -p ${orphanPath}`.quiet();

      await expect(
        git.ensureWorktreeRemoved(testDir, orphanPath, { force: true }),
      ).rejects.toThrow("Worktree directory still exists after cleanup");
    });
  });

  describe("ensureWorktreeExcluded", () => {
    test("creates .git/info/exclude if it does not exist", async () => {
      // Remove the exclude file if it exists
      await rm(join(testDir, ".git", "info", "exclude"), { force: true });

      await git.ensureWorktreeExcluded(testDir);

      const content = await readFile(join(testDir, ".git", "info", "exclude"), "utf-8");
      expect(content).toContain(".ralph-worktrees");
      expect(content).toContain(".ralph-planning");
    });

    test("appends to existing .git/info/exclude without duplicating", async () => {
      // Ensure exclude file exists with some content
      const excludePath = join(testDir, ".git", "info", "exclude");
      await Bun.write(excludePath, "*.log\n*.tmp\n");

      await git.ensureWorktreeExcluded(testDir);

      let content = await readFile(excludePath, "utf-8");
      expect(content).toContain("*.log");
      expect(content).toContain(".ralph-worktrees");
      expect(content).toContain(".ralph-planning");

      // Call again — should not duplicate
      await git.ensureWorktreeExcluded(testDir);

      content = await readFile(excludePath, "utf-8");
      expect((content.match(/\.ralph-worktrees/g) || []).length).toBe(1);
      expect((content.match(/\.ralph-planning/g) || []).length).toBe(1);
    });

    test("is idempotent when entry already exists", async () => {
      await git.ensureWorktreeExcluded(testDir);
      await git.ensureWorktreeExcluded(testDir);
      await git.ensureWorktreeExcluded(testDir);

      const content = await readFile(join(testDir, ".git", "info", "exclude"), "utf-8");
      expect((content.match(/\.ralph-worktrees/g) || []).length).toBe(1);
      expect((content.match(/\.ralph-planning/g) || []).length).toBe(1);
    });

    test("works when called from a worktree directory (where .git is a file)", async () => {
      // Create a worktree first
      const worktreePath = join(testDir, ".ralph-worktrees", "wt-exclude-test");
      await git.createWorktree(testDir, worktreePath, "ralph/wt-exclude-test");

      // Clear the exclude file to reset state
      const mainExcludePath = join(testDir, ".git", "info", "exclude");
      await Bun.write(mainExcludePath, "# empty\n");

      // Verify the worktree's .git is a file (gitdir pointer), not a directory
      const dotGitContent = await readFile(join(worktreePath, ".git"), "utf-8");
      expect(dotGitContent).toContain("gitdir:");

      // Call ensureWorktreeExcluded with the worktree path (not the main repo)
      await git.ensureWorktreeExcluded(worktreePath);

      // The exclude entry should be written to the main repo's .git/info/exclude,
      // not to a non-existent .git/info/exclude inside the worktree
      const content = await readFile(mainExcludePath, "utf-8");
      expect(content).toContain(".ralph-worktrees");
      expect(content).toContain(".ralph-planning");
    });
  });

  describe("worktree isolation", () => {
    test("changes in one worktree do not affect another", async () => {
      const path1 = join(testDir, ".ralph-worktrees", "isolated-1");
      const path2 = join(testDir, ".ralph-worktrees", "isolated-2");

      await git.createWorktree(testDir, path1, "ralph/isolated-1");
      await git.createWorktree(testDir, path2, "ralph/isolated-2");

      // Create a file in worktree 1
      await Bun.write(join(path1, "file-from-wt1.txt"), "content from wt1");
      await Bun.$`git -C ${path1} add .`.quiet();
      await Bun.$`git -C ${path1} commit -m "commit in wt1"`.quiet();

      // Verify the file does NOT exist in worktree 2
      const existsInWt2 = await Bun.file(join(path2, "file-from-wt1.txt")).exists();
      expect(existsInWt2).toBe(false);

      // Verify the file does NOT exist in main checkout
      const existsInMain = await Bun.file(join(testDir, "file-from-wt1.txt")).exists();
      expect(existsInMain).toBe(false);
    });

    test("main checkout branch is unchanged after worktree operations", async () => {
      const mainBranch = await git.getCurrentBranch(testDir);

      const worktreePath = join(testDir, ".ralph-worktrees", "no-affect-main");
      await git.createWorktree(testDir, worktreePath, "ralph/no-affect-main");

      // Verify main checkout is still on the same branch
      const branchAfter = await git.getCurrentBranch(testDir);
      expect(branchAfter).toBe(mainBranch);
    });

    test("each worktree has independent staging area", async () => {
      const path1 = join(testDir, ".ralph-worktrees", "staging-1");
      const path2 = join(testDir, ".ralph-worktrees", "staging-2");

      await git.createWorktree(testDir, path1, "ralph/staging-1");
      await git.createWorktree(testDir, path2, "ralph/staging-2");

      // Stage a file in worktree 1
      await Bun.write(join(path1, "staged.txt"), "staged content");
      await Bun.$`git -C ${path1} add staged.txt`.quiet();

      // Worktree 2 should have no staged changes
      const status = (await Bun.$`git -C ${path2} status --porcelain`.text()).trim();
      expect(status).toBe("");
    });
  });
});
