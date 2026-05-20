/**
 * Unit tests for GitService.
 */

import { test, expect, describe, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { CommandExecutor, CommandOptions, CommandResult } from "../../src/core/command-executor";
import { GitService, BranchMismatchError, GitCommandError } from "../../src/core/git-service";
import { log } from "../../src/core/logger";
import { cleanupTempGitRepository, createTempGitRepository } from "../helpers/git-fixtures";
import { TestCommandExecutor } from "../mocks/mock-executor";

describe("GitService", () => {
  class ScriptedCommandExecutor implements CommandExecutor {
    readonly calls: Array<{
      command: string;
      args: string[];
      options?: CommandOptions;
    }> = [];

    constructor(private readonly responses: CommandResult[]) {}

    async exec(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
      this.calls.push({ command, args, options });
      const response = this.responses.shift();
      if (!response) {
        throw new Error(`No scripted response left for ${command} ${args.join(" ")}`);
      }
      return response;
    }

    async fileExists(_path: string): Promise<boolean> {
      return false;
    }

    async directoryExists(_path: string): Promise<boolean> {
      return false;
    }

    async readFile(_path: string): Promise<string | null> {
      return null;
    }

    async listDirectory(_path: string): Promise<string[]> {
      return [];
    }

    async writeFile(_path: string, _content: string): Promise<boolean> {
      return false;
    }
  }

  interface GitServiceTestContext {
    testDir: string;
    git: GitService;
  }

  async function createGitServiceTestContext(): Promise<GitServiceTestContext> {
    const testDir = await createTempGitRepository({
      prefix: "ralpher-git-test-",
      initialCommit: "readme",
    });
    const git = new GitService(new TestCommandExecutor());

    return {
      testDir,
      git,
    };
  }

  async function teardownGitServiceTestContext(ctx: GitServiceTestContext): Promise<void> {
    await cleanupTempGitRepository(ctx.testDir);
  }

  async function withGitServiceTest(
    run: (context: GitServiceTestContext) => Promise<void> | void,
  ): Promise<void> {
    const ctx = await createGitServiceTestContext();
    try {
      await run(ctx);
    } finally {
      await teardownGitServiceTestContext(ctx);
    }
  }

  function getCommandCalls(executor: ScriptedCommandExecutor): string[][] {
    return executor.calls.map(({ command, args }) => [command, ...args]);
  }

  describe("isGitRepo", () => {
    test("returns true for a git repo", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        const result = await git.isGitRepo(testDir);
        expect(result).toBe(true);
      });
    });

    test("returns false for a non-repo directory", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const nonRepoDir = await mkdtemp(join(tmpdir(), "non-repo-"));
        try {
          const result = await git.isGitRepo(nonRepoDir);
          expect(result).toBe(false);
        } finally {
          await rm(nonRepoDir, { recursive: true });
        }

      });

    });
  });

  describe("getCurrentBranch", () => {
    test("returns the current branch name", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        const branch = await git.getCurrentBranch(testDir);
        // Default branch could be main or master
        expect(["main", "master"]).toContain(branch);
      });
    });
  });

  describe("hasUncommittedChanges", () => {
    test("returns false when no changes", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        const result = await git.hasUncommittedChanges(testDir);
        expect(result).toBe(false);
      });
    });

    test("returns true when there are changes", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        await writeFile(join(testDir, "new-file.txt"), "Hello\n");
        const result = await git.hasUncommittedChanges(testDir);
        expect(result).toBe(true);

      });

    });
  });

  describe("getChangedFiles", () => {
    test("returns empty array when no changes", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        const files = await git.getChangedFiles(testDir);
        expect(files).toEqual([]);
      });
    });

    test("returns list of changed files", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        await writeFile(join(testDir, "file1.txt"), "Hello\n");
        await writeFile(join(testDir, "file2.txt"), "World\n");
  
        const files = await git.getChangedFiles(testDir);
        expect(files.length).toBe(2);
        expect(files).toContain("file1.txt");
        expect(files).toContain("file2.txt");

      });

    });
  });

  describe("createBranch and checkoutBranch", () => {
    test("creates a new branch and checks it out", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        await git.createBranch(testDir, "test-branch");
        const branch = await git.getCurrentBranch(testDir);
        expect(branch).toBe("test-branch");
      });
    });

    test("checkoutBranch switches to an existing branch", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
  
        await git.createBranch(testDir, "other-branch");
        expect(await git.getCurrentBranch(testDir)).toBe("other-branch");
  
        await git.checkoutBranch(testDir, originalBranch);
        expect(await git.getCurrentBranch(testDir)).toBe(originalBranch);

      });

    });
  });

  describe("getLocalBranches", () => {
    test("returns all local branches with current marked", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        // Get the default branch name (could be main or master depending on git config)
        const defaultBranch = await git.getCurrentBranch(testDir);
        
        // Create additional branches
        await git.createBranch(testDir, "feature-a");
        await git.checkoutBranch(testDir, defaultBranch);
        await git.createBranch(testDir, "feature-b");
        await git.checkoutBranch(testDir, defaultBranch);
  
        const branches = await git.getLocalBranches(testDir);
        
        expect(branches.length).toBeGreaterThanOrEqual(3);
        
        // Check that current branch is marked
        const currentBranch = branches.find(b => b.current);
        expect(currentBranch).toBeDefined();
        expect(currentBranch?.name).toBe(defaultBranch);
        
        // Check that feature branches exist
        const featureA = branches.find(b => b.name === "feature-a");
        const featureB = branches.find(b => b.name === "feature-b");
        expect(featureA).toBeDefined();
        expect(featureB).toBeDefined();
        expect(featureA?.current).toBe(false);
        expect(featureB?.current).toBe(false);
      });
    });

    test("returns current branch for repo with no commits (empty repo)", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        // Create a new empty repo (no commits)
        const emptyRepoDir = await mkdtemp(join(tmpdir(), "ralpher-empty-repo-"));
        try {
          await Bun.$`git init ${emptyRepoDir}`.quiet();
          
          const branches = await git.getLocalBranches(emptyRepoDir);
          
          // Should return the current branch even though there are no commits
          expect(branches.length).toBe(1);
          expect(branches[0]?.current).toBe(true);
          // Branch name is typically "main" or "master" depending on git config
          const branchName = branches[0]?.name ?? "";
          expect(["main", "master"]).toContain(branchName);
        } finally {
          await rm(emptyRepoDir, { recursive: true });
        }

      });

    });
  });

  describe("branchExists", () => {
    test("returns true for existing branch", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        const currentBranch = await git.getCurrentBranch(testDir);
        const exists = await git.branchExists(testDir, currentBranch);
        expect(exists).toBe(true);
      });
    });

    test("returns false for non-existent branch", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const exists = await git.branchExists(testDir, "non-existent-branch");
        expect(exists).toBe(false);

      });

    });
  });

  describe("commit", () => {
    test("commits staged changes and returns commit info", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        await writeFile(join(testDir, "new-file.txt"), "Content\n");
  
        const commitInfo = await git.commit(testDir, "Test commit message");
  
        expect(commitInfo.sha).toHaveLength(40);
        expect(commitInfo.message).toBe("Test commit message");
        expect(commitInfo.filesChanged).toBe(1);
  
        // Verify no uncommitted changes
        const hasChanges = await git.hasUncommittedChanges(testDir);
        expect(hasChanges).toBe(false);
      });
    });

    test("throws when no changes to commit", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        await expect(git.commit(testDir, "Empty commit")).rejects.toThrow(
          "No changes to commit"
        );

      });

    });
  });

  describe("deleteBranch", () => {
    test("deletes a branch", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
  
        await git.createBranch(testDir, "to-delete");
        await git.checkoutBranch(testDir, originalBranch);
        await git.deleteBranch(testDir, "to-delete");
  
        const exists = await git.branchExists(testDir, "to-delete");
        expect(exists).toBe(false);
      });
    });
  });

  describe("stash and stashPop", () => {
    test("stashes and restores changes", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        await writeFile(join(testDir, "stash-file.txt"), "Stash me\n");
        expect(await git.hasUncommittedChanges(testDir)).toBe(true);
  
        await git.stash(testDir);
        expect(await git.hasUncommittedChanges(testDir)).toBe(false);
  
        await git.stashPop(testDir);
        expect(await git.hasUncommittedChanges(testDir)).toBe(true);
      });
    });
  });

  describe("mergeBranch", () => {
    test("merges source branch into target branch", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
  
        // Create a feature branch with a commit
        await git.createBranch(testDir, "feature");
        await writeFile(join(testDir, "feature-file.txt"), "Feature\n");
        await git.commit(testDir, "Add feature");
  
        // Merge back to original
        const mergeCommit = await git.mergeBranch(testDir, "feature", originalBranch);
  
        expect(mergeCommit).toHaveLength(40);
        expect(await git.getCurrentBranch(testDir)).toBe(originalBranch);
      });
    });
  });

  describe("getDiff", () => {
    test("returns empty array when no changes between branches", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
        await git.createBranch(testDir, "feature-no-changes");
        
        const diffs = await git.getDiff(testDir, originalBranch);
        expect(diffs).toEqual([]);
      });
    });

    test("returns file diffs for added files", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
        await git.createBranch(testDir, "feature-add");
        
        await writeFile(join(testDir, "new-file.txt"), "Hello World\n");
        await git.commit(testDir, "Add new file");
        
        const diffs = await git.getDiff(testDir, originalBranch);
        expect(diffs.length).toBe(1);
        expect(diffs[0]?.path).toBe("new-file.txt");
        expect(diffs[0]?.status).toBe("added");
        expect(diffs[0]?.additions).toBeGreaterThan(0);

      });

    });

    test("returns file diffs for modified files", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
        await git.createBranch(testDir, "feature-modify");
        
        // Modify existing README.md
        await writeFile(join(testDir, "README.md"), "# Test\n\nModified content\n");
        await git.commit(testDir, "Modify README");
        
        const diffs = await git.getDiff(testDir, originalBranch);
        expect(diffs.length).toBe(1);
        expect(diffs[0]?.path).toBe("README.md");
        expect(diffs[0]?.status).toBe("modified");

      });

    });

    test("returns file diffs for deleted files", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
        await git.createBranch(testDir, "feature-delete");
        
        // Delete README.md
        await Bun.$`rm ${join(testDir, "README.md")}`.quiet();
        await git.commit(testDir, "Delete README");
        
        const diffs = await git.getDiff(testDir, originalBranch);
        expect(diffs.length).toBe(1);
        expect(diffs[0]?.path).toBe("README.md");
        expect(diffs[0]?.status).toBe("deleted");
        expect(diffs[0]?.deletions).toBeGreaterThan(0);

      });

    });

    test("returns multiple file diffs", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
        await git.createBranch(testDir, "feature-multiple");
        
        await writeFile(join(testDir, "file1.txt"), "Content 1\n");
        await writeFile(join(testDir, "file2.txt"), "Content 2\n");
        await writeFile(join(testDir, "README.md"), "# Updated\n");
        await git.commit(testDir, "Multiple changes");
        
        const diffs = await git.getDiff(testDir, originalBranch);
        expect(diffs.length).toBe(3);
        
        const paths = diffs.map(d => d.path).sort();
        expect(paths).toEqual(["README.md", "file1.txt", "file2.txt"]);

      });

    });
  });

  describe("getDiffWithContent", () => {
    test("returns diffs with patch content for added files", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
        await git.createBranch(testDir, "feature-patch-add");
        
        await writeFile(join(testDir, "new-file.txt"), "Hello World\nLine 2\n");
        await git.commit(testDir, "Add new file");
        
        const diffs = await git.getDiffWithContent(testDir, originalBranch);
        expect(diffs.length).toBe(1);
        expect(diffs[0]?.path).toBe("new-file.txt");
        expect(diffs[0]?.patch).toBeDefined();
        expect(diffs[0]?.patch).toContain("diff --git");
        expect(diffs[0]?.patch).toContain("+Hello World");
        expect(diffs[0]?.patch).toContain("+Line 2");
      });
    });

    test("returns diffs with patch content for modified files", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
        await git.createBranch(testDir, "feature-patch-modify");
        
        await writeFile(join(testDir, "README.md"), "# Updated Title\n\nNew content here\n");
        await git.commit(testDir, "Update README");
        
        const diffs = await git.getDiffWithContent(testDir, originalBranch);
        expect(diffs.length).toBe(1);
        expect(diffs[0]?.path).toBe("README.md");
        expect(diffs[0]?.patch).toBeDefined();
        expect(diffs[0]?.patch).toContain("diff --git");
        expect(diffs[0]?.patch).toContain("-# Test");
        expect(diffs[0]?.patch).toContain("+# Updated Title");

      });

    });

    test("returns diffs with patch content for multiple files", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
        await git.createBranch(testDir, "feature-patch-multi");
        
        await writeFile(join(testDir, "file1.txt"), "File 1 content\n");
        await writeFile(join(testDir, "file2.txt"), "File 2 content\n");
        await git.commit(testDir, "Add two files");
        
        const diffs = await git.getDiffWithContent(testDir, originalBranch);
        expect(diffs.length).toBe(2);
        
        // Both files should have patches
        for (const diff of diffs) {
          expect(diff.patch).toBeDefined();
          expect(diff.patch).toContain("diff --git");
        }
        
        // Check specific content
        const file1Diff = diffs.find(d => d.path === "file1.txt");
        const file2Diff = diffs.find(d => d.path === "file2.txt");
        
        expect(file1Diff?.patch).toContain("+File 1 content");
        expect(file2Diff?.patch).toContain("+File 2 content");

      });

    });

    test("returns empty patch for files with no diff content available", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
        
        // No changes on the branch
        await git.createBranch(testDir, "feature-no-patch");
        
        const diffs = await git.getDiffWithContent(testDir, originalBranch);
        expect(diffs).toEqual([]);

      });

    });

    test("handles files with special characters in path", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
        await git.createBranch(testDir, "feature-special-path");
        
        // Create a file in a subdirectory
        await Bun.$`mkdir -p ${join(testDir, "src/components")}`.quiet();
        await writeFile(join(testDir, "src/components/Button.tsx"), "export const Button = () => <button />;\n");
        await git.commit(testDir, "Add component");
        
        const diffs = await git.getDiffWithContent(testDir, originalBranch);
        expect(diffs.length).toBe(1);
        expect(diffs[0]?.path).toBe("src/components/Button.tsx");
        expect(diffs[0]?.patch).toBeDefined();
        expect(diffs[0]?.patch).toContain("diff --git");

      });

    });
  });

  describe("getFileDiffContent", () => {
    test("returns patch content for a specific file", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
        await git.createBranch(testDir, "feature-file-diff");
        
        await writeFile(join(testDir, "specific-file.txt"), "Specific content\n");
        await writeFile(join(testDir, "other-file.txt"), "Other content\n");
        await git.commit(testDir, "Add files");
        
        const patch = await git.getFileDiffContent(testDir, originalBranch, "specific-file.txt");
        expect(patch).toContain("diff --git");
        expect(patch).toContain("+Specific content");
        expect(patch).not.toContain("Other content");
      });
    });
  });

  describe("getDiffSummary", () => {
    test("returns summary of changes", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
        await git.createBranch(testDir, "feature-summary");
        
        await writeFile(join(testDir, "file1.txt"), "Line 1\nLine 2\nLine 3\n");
        await writeFile(join(testDir, "file2.txt"), "Content\n");
        await git.commit(testDir, "Add files");
        
        const summary = await git.getDiffSummary(testDir, originalBranch);
        expect(summary.files).toBe(2);
        expect(summary.insertions).toBe(4); // 3 lines in file1 + 1 line in file2
        expect(summary.deletions).toBe(0);
      });
    });

    test("returns zero summary when no changes", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
        await git.createBranch(testDir, "feature-no-summary");
        
        const summary = await git.getDiffSummary(testDir, originalBranch);
        expect(summary.files).toBe(0);
        expect(summary.insertions).toBe(0);
        expect(summary.deletions).toBe(0);

      });

    });
  });

  describe("pull", () => {
    test("returns false when no remote is configured", async () => {
      const executor = new ScriptedCommandExecutor([
        {
          success: false,
          stdout: "",
          stderr: "error: No such remote 'origin'\n",
          exitCode: 2,
        },
      ]);
      const git = new GitService(executor);

      await expect(git.pull("/repo")).resolves.toBe(false);
      expect(getCommandCalls(executor)).toEqual([
        ["git", "-C", "/repo", "remote", "get-url", "origin"],
      ]);
    });

    test("does not log an error for the expected missing remote probe", async () => {
      const executor = new ScriptedCommandExecutor([
        {
          success: false,
          stdout: "",
          stderr: "error: No such remote 'origin'\n",
          exitCode: 2,
        },
      ]);
      const git = new GitService(executor);
      const errorSpy = spyOn(log, "error");

      try {
        await expect(git.pull("/repo")).resolves.toBe(false);
        expect(errorSpy).not.toHaveBeenCalled();
      } finally {
        errorSpy.mockRestore();
      }
    });

    test("returns false when remote branch does not exist", async () => {
      const executor = new ScriptedCommandExecutor([
        {
          success: true,
          stdout: "/tmp/origin.git\n",
          stderr: "",
          exitCode: 0,
        },
        {
          success: false,
          stdout: "",
          stderr: "fatal: couldn't find remote ref non-existent-branch\n",
          exitCode: 128,
        },
      ]);
      const git = new GitService(executor);

      await expect(git.pull("/repo", "non-existent-branch")).resolves.toBe(false);
      expect(getCommandCalls(executor)).toEqual([
        ["git", "-C", "/repo", "remote", "get-url", "origin"],
        ["git", "-C", "/repo", "fetch", "origin", "non-existent-branch"],
      ]);
    });

    test("successfully pulls when remote has changes", async () => {
      const executor = new ScriptedCommandExecutor([
        {
          success: true,
          stdout: "/tmp/origin.git\n",
          stderr: "",
          exitCode: 0,
        },
        {
          success: true,
          stdout: "",
          stderr: "",
          exitCode: 0,
        },
        {
          success: true,
          stdout: "Updating 123..456\nFast-forward\n",
          stderr: "",
          exitCode: 0,
        },
      ]);
      const git = new GitService(executor);

      await expect(git.pull("/repo", "main")).resolves.toBe(true);
      expect(getCommandCalls(executor)).toEqual([
        ["git", "-C", "/repo", "remote", "get-url", "origin"],
        ["git", "-C", "/repo", "fetch", "origin", "main"],
        ["git", "-C", "/repo", "merge", "--ff-only", "origin/main"],
      ]);
    });

    test("uses current branch when no branch name is specified", async () => {
      const executor = new ScriptedCommandExecutor([
        {
          success: true,
          stdout: "/tmp/origin.git\n",
          stderr: "",
          exitCode: 0,
        },
        {
          success: true,
          stdout: "feature/current\n",
          stderr: "",
          exitCode: 0,
        },
        {
          success: true,
          stdout: "",
          stderr: "",
          exitCode: 0,
        },
        {
          success: true,
          stdout: "Already up to date.\n",
          stderr: "",
          exitCode: 0,
        },
      ]);
      const git = new GitService(executor);

      await expect(git.pull("/repo")).resolves.toBe(true);
      expect(getCommandCalls(executor)).toEqual([
        ["git", "-C", "/repo", "remote", "get-url", "origin"],
        ["git", "-C", "/repo", "rev-parse", "--abbrev-ref", "HEAD"],
        ["git", "-C", "/repo", "fetch", "origin", "feature/current"],
        ["git", "-C", "/repo", "merge", "--ff-only", "origin/feature/current"],
      ]);
    });

    test("returns false when fast-forward merge is not possible", async () => {
      const executor = new ScriptedCommandExecutor([
        {
          success: true,
          stdout: "/tmp/origin.git\n",
          stderr: "",
          exitCode: 0,
        },
        {
          success: true,
          stdout: "",
          stderr: "",
          exitCode: 0,
        },
        {
          success: false,
          stdout: "",
          stderr: "fatal: Not possible to fast-forward, aborting.\n",
          exitCode: 128,
        },
      ]);
      const git = new GitService(executor);

      await expect(git.pull("/repo", "main")).resolves.toBe(false);
      expect(getCommandCalls(executor)).toEqual([
        ["git", "-C", "/repo", "remote", "get-url", "origin"],
        ["git", "-C", "/repo", "fetch", "origin", "main"],
        ["git", "-C", "/repo", "merge", "--ff-only", "origin/main"],
      ]);
    });
  });

  describe("SSH host key auto-accept", () => {
    test("retries push by extending an existing GIT_SSH_COMMAND and persisting known hosts in git dir", async () => {
      const executor = new ScriptedCommandExecutor([
        {
          success: false,
          stdout: "",
          stderr: "Host key verification failed.\nfatal: Could not read from remote repository.\n",
          exitCode: 128,
        },
        {
          success: true,
          stdout: "ssh -i /tmp/custom-key",
          stderr: "",
          exitCode: 0,
        },
        {
          success: true,
          stdout: ".git/ralpher-known-hosts\n",
          stderr: "",
          exitCode: 0,
        },
        {
          success: true,
          stdout: "branch 'feature/test' set up to track 'origin/feature/test'.\n",
          stderr: "",
          exitCode: 0,
        },
      ]);
      const git = new GitService(executor);

      const remoteBranch = await git.pushBranch("/repo", "feature/test");

      expect(remoteBranch).toBe("origin/feature/test");
      expect(executor.calls).toHaveLength(4);
      expect(executor.calls[0]?.command).toBe("git");
      expect(executor.calls[0]?.args).toEqual(["-C", "/repo", "push", "-u", "origin", "feature/test"]);
      expect(executor.calls[0]?.options?.env).toBeUndefined();
      expect(executor.calls[1]?.command).toBe("bash");
      expect(executor.calls[1]?.args).toEqual(["-lc", "printf %s \"${GIT_SSH_COMMAND:-}\""]);
      expect(executor.calls[2]?.args).toEqual(["-C", "/repo", "rev-parse", "--git-path", "ralpher-known-hosts"]);
      expect(executor.calls[3]?.options?.env).toEqual({
        GIT_SSH_COMMAND: "ssh -i /tmp/custom-key -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile='/repo/.git/ralpher-known-hosts'",
      });
    });

    test("retries fetch by extending core.sshCommand when no GIT_SSH_COMMAND override is set", async () => {
      const executor = new ScriptedCommandExecutor([
        {
          success: true,
          stdout: "git@github.com:owner/repo.git\n",
          stderr: "",
          exitCode: 0,
        },
        {
          success: false,
          stdout: "",
          stderr: "Host key verification failed.\nfatal: Could not read from remote repository.\n",
          exitCode: 128,
        },
        {
          success: true,
          stdout: "",
          stderr: "",
          exitCode: 0,
        },
        {
          success: true,
          stdout: "ssh -i ~/.ssh/review-key\n",
          stderr: "",
          exitCode: 0,
        },
        {
          success: true,
          stdout: ".git/ralpher-known-hosts\n",
          stderr: "",
          exitCode: 0,
        },
        {
          success: true,
          stdout: "",
          stderr: "",
          exitCode: 0,
        },
      ]);
      const git = new GitService(executor);

      const fetched = await git.fetchBranch("/repo", "main");

      expect(fetched).toBe(true);
      expect(executor.calls).toHaveLength(6);
      expect(executor.calls[2]?.command).toBe("bash");
      expect(executor.calls[3]?.args).toEqual(["-C", "/repo", "config", "--get", "core.sshCommand"]);
      expect(executor.calls[4]?.args).toEqual(["-C", "/repo", "rev-parse", "--git-path", "ralpher-known-hosts"]);
      expect(executor.calls[5]?.args).toEqual(["-C", "/repo", "fetch", "origin", "main"]);
      expect(executor.calls[5]?.options?.env).toEqual({
        GIT_SSH_COMMAND: "ssh -i ~/.ssh/review-key -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile='/repo/.git/ralpher-known-hosts'",
      });
    });

    test("does not retry unrelated push failures", async () => {
      const executor = new ScriptedCommandExecutor([
        {
          success: false,
          stdout: "",
          stderr: "fatal: repository 'origin' does not exist\n",
          exitCode: 128,
        },
      ]);
      const git = new GitService(executor);

      await expect(git.pushBranch("/repo", "feature/test")).rejects.toBeInstanceOf(GitCommandError);
      expect(executor.calls).toHaveLength(1);
      expect(executor.calls[0]?.options?.env).toBeUndefined();
    });
  });

  describe("getDefaultBranch", () => {
    test("returns branch from origin/HEAD when set", async () => {
      const executor = new ScriptedCommandExecutor([
        {
          success: true,
          stdout: "refs/remotes/origin/develop\n",
          stderr: "",
          exitCode: 0,
        },
      ]);
      const git = new GitService(executor);

      await expect(git.getDefaultBranch("/repo")).resolves.toBe("develop");
      expect(getCommandCalls(executor)).toEqual([
        ["git", "-C", "/repo", "symbolic-ref", "refs/remotes/origin/HEAD"],
      ]);
    });

    test("falls back to main when origin/HEAD is not set but main exists", async () => {
      const executor = new ScriptedCommandExecutor([
        {
          success: false,
          stdout: "",
          stderr: "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref\n",
          exitCode: 128,
        },
        {
          success: true,
          stdout: "deadbeef\n",
          stderr: "",
          exitCode: 0,
        },
      ]);
      const git = new GitService(executor);

      await expect(git.getDefaultBranch("/repo")).resolves.toBe("main");
      expect(getCommandCalls(executor)).toEqual([
        ["git", "-C", "/repo", "symbolic-ref", "refs/remotes/origin/HEAD"],
        ["git", "-C", "/repo", "rev-parse", "--verify", "main"],
      ]);
    });

    test("falls back to master when main does not exist but master does", async () => {
      const executor = new ScriptedCommandExecutor([
        {
          success: false,
          stdout: "",
          stderr: "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref\n",
          exitCode: 128,
        },
        {
          success: false,
          stdout: "",
          stderr: "fatal: Needed a single revision\n",
          exitCode: 128,
        },
        {
          success: true,
          stdout: "deadbeef\n",
          stderr: "",
          exitCode: 0,
        },
      ]);
      const git = new GitService(executor);

      await expect(git.getDefaultBranch("/repo")).resolves.toBe("master");
      expect(getCommandCalls(executor)).toEqual([
        ["git", "-C", "/repo", "symbolic-ref", "refs/remotes/origin/HEAD"],
        ["git", "-C", "/repo", "rev-parse", "--verify", "main"],
        ["git", "-C", "/repo", "rev-parse", "--verify", "master"],
      ]);
    });

    test("falls back to current branch when neither main nor master exists", async () => {
      const executor = new ScriptedCommandExecutor([
        {
          success: false,
          stdout: "",
          stderr: "fatal: ref refs/remotes/origin/HEAD is not a symbolic ref\n",
          exitCode: 128,
        },
        {
          success: false,
          stdout: "",
          stderr: "fatal: Needed a single revision\n",
          exitCode: 128,
        },
        {
          success: false,
          stdout: "",
          stderr: "fatal: Needed a single revision\n",
          exitCode: 128,
        },
        {
          success: true,
          stdout: "develop\n",
          stderr: "",
          exitCode: 0,
        },
      ]);
      const git = new GitService(executor);

      await expect(git.getDefaultBranch("/repo")).resolves.toBe("develop");
      expect(getCommandCalls(executor)).toEqual([
        ["git", "-C", "/repo", "symbolic-ref", "refs/remotes/origin/HEAD"],
        ["git", "-C", "/repo", "rev-parse", "--verify", "main"],
        ["git", "-C", "/repo", "rev-parse", "--verify", "master"],
        ["git", "-C", "/repo", "rev-parse", "--abbrev-ref", "HEAD"],
      ]);
    });

    test("prefers origin/HEAD over local main branch", async () => {
      const executor = new ScriptedCommandExecutor([
        {
          success: true,
          stdout: "refs/remotes/origin/develop\n",
          stderr: "",
          exitCode: 0,
        },
      ]);
      const git = new GitService(executor);

      await expect(git.getDefaultBranch("/repo")).resolves.toBe("develop");
      expect(getCommandCalls(executor)).toEqual([
        ["git", "-C", "/repo", "symbolic-ref", "refs/remotes/origin/HEAD"],
      ]);
    });
  });

  describe("verifyBranch", () => {
    test("returns matches: true when on expected branch", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        const currentBranch = await git.getCurrentBranch(testDir);
        const result = await git.verifyBranch(testDir, currentBranch);
        
        expect(result.matches).toBe(true);
        expect(result.currentBranch).toBe(currentBranch);
        expect(result.expectedBranch).toBe(currentBranch);
      });
    });

    test("returns matches: false when on different branch", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
        await git.createBranch(testDir, "other-branch");
        
        const result = await git.verifyBranch(testDir, originalBranch);
        
        expect(result.matches).toBe(false);
        expect(result.currentBranch).toBe("other-branch");
        expect(result.expectedBranch).toBe(originalBranch);

      });

    });
  });

  describe("ensureBranch", () => {
    test("returns wasOnExpectedBranch: true when already on expected branch", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        const currentBranch = await git.getCurrentBranch(testDir);
        const result = await git.ensureBranch(testDir, currentBranch);
        
        expect(result.wasOnExpectedBranch).toBe(true);
        expect(result.currentBranch).toBe(currentBranch);
        expect(result.expectedBranch).toBe(currentBranch);
        expect(result.checkedOut).toBe(false);
      });
    });

    test("throws BranchMismatchError when on different branch without autoCheckout", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
        await git.createBranch(testDir, "other-branch");
        
        try {
          await git.ensureBranch(testDir, originalBranch);
          expect(true).toBe(false); // Should not reach here
        } catch (error) {
          expect(error).toBeInstanceOf(BranchMismatchError);
          const branchError = error as BranchMismatchError;
          expect(branchError.code).toBe("BRANCH_MISMATCH");
          expect(branchError.currentBranch).toBe("other-branch");
          expect(branchError.expectedBranch).toBe(originalBranch);
        }

      });

    });

    test("auto-checkouts to expected branch when autoCheckout is true", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
        await git.createBranch(testDir, "other-branch");
        
        // Should be on other-branch now
        expect(await git.getCurrentBranch(testDir)).toBe("other-branch");
        
        const result = await git.ensureBranch(testDir, originalBranch, { autoCheckout: true });
        
        expect(result.wasOnExpectedBranch).toBe(false);
        expect(result.currentBranch).toBe("other-branch");
        expect(result.expectedBranch).toBe(originalBranch);
        expect(result.checkedOut).toBe(true);
        
        // Should now be on the original branch
        expect(await git.getCurrentBranch(testDir)).toBe(originalBranch);

      });

    });

    test("throws error when autoCheckout fails due to uncommitted changes", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
        await git.createBranch(testDir, "other-branch");
        
        // Create uncommitted changes
        await writeFile(join(testDir, "uncommitted.txt"), "uncommitted\n");
        
        try {
          await git.ensureBranch(testDir, originalBranch, { autoCheckout: true });
          expect(true).toBe(false); // Should not reach here
        } catch (error) {
          expect(String(error)).toContain("uncommitted changes exist");
        }

      });

    });
  });

  describe("BranchMismatchError", () => {
    test("has correct properties", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        const error = new BranchMismatchError("current-branch", "expected-branch");
        
        expect(error.name).toBe("BranchMismatchError");
        expect(error.code).toBe("BRANCH_MISMATCH");
        expect(error.currentBranch).toBe("current-branch");
        expect(error.expectedBranch).toBe("expected-branch");
        expect(error.message).toBe("Branch mismatch: expected 'expected-branch' but on 'current-branch'");
      });
    });
  });

  describe("commit with expectedBranch", () => {
    test("commits successfully when on expected branch", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        const currentBranch = await git.getCurrentBranch(testDir);
        await writeFile(join(testDir, "new-file.txt"), "new content\n");
        
        const commitInfo = await git.commit(testDir, "Test commit", {
          expectedBranch: currentBranch,
        });
        
        expect(commitInfo.sha).toBeDefined();
        expect(commitInfo.filesChanged).toBe(1);
      });
    });

    test("auto-checkouts to expected branch when working tree is clean", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
        
        // Create and switch to another branch
        await git.createBranch(testDir, "other-branch");
        
        // Now we're on other-branch with clean working tree
        // Verify we can auto-checkout to original (even though no changes to commit)
        // We'll test ensureBranch directly since commit requires changes
        const result = await git.ensureBranch(testDir, originalBranch, { autoCheckout: true });
        
        expect(result.wasOnExpectedBranch).toBe(false);
        expect(result.checkedOut).toBe(true);
        expect(await git.getCurrentBranch(testDir)).toBe(originalBranch);

      });

    });
    
    test("fails to auto-recover when uncommitted changes exist on wrong branch", async () => {
    
      await withGitServiceTest(async (context) => {
    
        const { testDir, git } = context;
    
        void testDir;
    
        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
        
        // Create and switch to another branch
        await git.createBranch(testDir, "other-branch-2");
        
        // Create uncommitted changes on the wrong branch
        await writeFile(join(testDir, "uncommitted.txt"), "uncommitted content\n");
        
        // Try to commit with expectedBranch pointing to original - should fail
        await expect(
          git.commit(testDir, "Test commit", { expectedBranch: originalBranch })
        ).rejects.toThrow(/Cannot auto-checkout.*uncommitted changes exist/);
        
        // Verify we're still on the wrong branch
        expect(await git.getCurrentBranch(testDir)).toBe("other-branch-2");
    
      });
    
    });
  });

  describe("resetHard with expectedBranch", () => {
    test("resets successfully when on expected branch", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        const currentBranch = await git.getCurrentBranch(testDir);
        await writeFile(join(testDir, "new-file.txt"), "new content\n");
        
        await git.resetHard(testDir, { expectedBranch: currentBranch });
        
        const hasChanges = await git.hasUncommittedChanges(testDir);
        expect(hasChanges).toBe(false);
      });
    });

    test("switches to expected branch before reset when on wrong branch", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
        
        // Create another branch with a file
        await git.createBranch(testDir, "other-branch");
        await writeFile(join(testDir, "other-file.txt"), "other content\n");
        await git.commit(testDir, "Other commit");
        
        // Create uncommitted changes
        await writeFile(join(testDir, "uncommitted.txt"), "uncommitted\n");
        
        // Reset with expectedBranch pointing to original
        // This should switch to original branch (discarding changes) then reset
        await git.resetHard(testDir, { expectedBranch: originalBranch });
        
        // Should now be on original branch with clean state
        expect(await git.getCurrentBranch(testDir)).toBe(originalBranch);
        const hasChanges = await git.hasUncommittedChanges(testDir);
        expect(hasChanges).toBe(false);

      });

    });

    test("handles conflicting tracked file changes when switching branches", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const originalBranch = await git.getCurrentBranch(testDir);
        
        // Create a tracked file on original branch
        await writeFile(join(testDir, "shared-file.txt"), "original content\n");
        await git.commit(testDir, "Add shared file");
        
        // Create another branch and modify the tracked file
        await git.createBranch(testDir, "feature-branch");
        await writeFile(join(testDir, "shared-file.txt"), "feature content\n");
        await git.commit(testDir, "Modify shared file on feature branch");
        
        // Now modify the same tracked file WITHOUT committing
        // This creates a scenario where regular git checkout would fail
        await writeFile(join(testDir, "shared-file.txt"), "uncommitted changes that conflict\n");
        
        // Verify we have uncommitted changes to a tracked file
        expect(await git.hasUncommittedChanges(testDir)).toBe(true);
        
        // Reset with expectedBranch pointing to original - this previously would fail
        // because regular checkout fails when tracked files have conflicting changes
        await git.resetHard(testDir, { expectedBranch: originalBranch });
        
        // Should now be on original branch with clean state
        expect(await git.getCurrentBranch(testDir)).toBe(originalBranch);
        expect(await git.hasUncommittedChanges(testDir)).toBe(false);
        
        // Verify the file contains the original branch content
        const content = await Bun.file(join(testDir, "shared-file.txt")).text();
        expect(content).toBe("original content\n");

      });

    });
  });

  describe("cleanupStaleLockFiles", () => {
    test("removes existing lock file", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        const { stat } = await import("fs/promises");
        
        // Ensure .git directory exists (it should from beforeEach)
        const lockFile = join(testDir, ".git", "index.lock");
        
        // Create a stale lock file
        await writeFile(lockFile, "");
        
        // Verify lock file exists
        const statBefore = await stat(lockFile).catch(() => null);
        expect(statBefore).not.toBeNull();
        
        // Clean up
        const cleaned = await GitService.cleanupStaleLockFiles(testDir);
        expect(cleaned).toBe(true);
        
        // Verify lock file is removed
        const statAfter = await stat(lockFile).catch(() => null);
        expect(statAfter).toBeNull();
      });
    });

    test("returns false when no lock file exists", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        // No lock file exists by default
        const cleaned = await GitService.cleanupStaleLockFiles(testDir);
        expect(cleaned).toBe(false);

      });

    });

    test("handles repeated cleanup with retries", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const { stat } = await import("fs/promises");
        
        const lockFile = join(testDir, ".git", "index.lock");
        
        // Create a stale lock file
        await writeFile(lockFile, "");
        
        // Clean up with retries
        const cleaned = await GitService.cleanupStaleLockFiles(testDir, 3, 10);
        expect(cleaned).toBe(true);
        
        // Verify lock file is removed
        const statAfter = await stat(lockFile).catch(() => null);
        expect(statAfter).toBeNull();

      });

    });

    test("works on non-existent directory gracefully", async () => {
      const cleaned = await GitService.cleanupStaleLockFiles("/tmp/nonexistent-dir-12345");
      expect(cleaned).toBe(false);
    });
  });

  describe("fetchBranch", () => {
    test("returns false when no remote is configured", async () => {
      const executor = new ScriptedCommandExecutor([
        {
          success: false,
          stdout: "",
          stderr: "error: No such remote 'origin'\n",
          exitCode: 2,
        },
      ]);
      const git = new GitService(executor);

      await expect(git.fetchBranch("/repo", "main")).resolves.toBe(false);
      expect(getCommandCalls(executor)).toEqual([
        ["git", "-C", "/repo", "remote", "get-url", "origin"],
      ]);
    });

    test("returns false when remote branch does not exist", async () => {
      const executor = new ScriptedCommandExecutor([
        {
          success: true,
          stdout: "/tmp/origin.git\n",
          stderr: "",
          exitCode: 0,
        },
        {
          success: false,
          stdout: "",
          stderr: "fatal: couldn't find remote ref non-existent-branch\n",
          exitCode: 128,
        },
      ]);
      const git = new GitService(executor);

      await expect(git.fetchBranch("/repo", "non-existent-branch")).resolves.toBe(false);
      expect(getCommandCalls(executor)).toEqual([
        ["git", "-C", "/repo", "remote", "get-url", "origin"],
        ["git", "-C", "/repo", "fetch", "origin", "non-existent-branch"],
      ]);
    });

    test("successfully fetches an existing remote branch", async () => {
      const executor = new ScriptedCommandExecutor([
        {
          success: true,
          stdout: "/tmp/origin.git\n",
          stderr: "",
          exitCode: 0,
        },
        {
          success: true,
          stdout: "",
          stderr: "",
          exitCode: 0,
        },
      ]);
      const git = new GitService(executor);

      await expect(git.fetchBranch("/repo", "main")).resolves.toBe(true);
      expect(getCommandCalls(executor)).toEqual([
        ["git", "-C", "/repo", "remote", "get-url", "origin"],
        ["git", "-C", "/repo", "fetch", "origin", "main"],
      ]);
    });

    test("returns false for other fetch failures without retrying", async () => {
      const executor = new ScriptedCommandExecutor([
        {
          success: true,
          stdout: "/tmp/origin.git\n",
          stderr: "",
          exitCode: 0,
        },
        {
          success: false,
          stdout: "",
          stderr: "fatal: unable to access remote\n",
          exitCode: 128,
        },
      ]);
      const git = new GitService(executor);

      await expect(git.fetchBranch("/repo", "main")).resolves.toBe(false);
      expect(getCommandCalls(executor)).toEqual([
        ["git", "-C", "/repo", "remote", "get-url", "origin"],
        ["git", "-C", "/repo", "fetch", "origin", "main"],
      ]);
    });
  });

  describe("isAncestor", () => {
    test("returns true when ref is an ancestor", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        // The initial commit is an ancestor of any subsequent commit
        const initialSha = (await Bun.$`git -C ${testDir} rev-parse HEAD`.text()).trim();
  
        await writeFile(join(testDir, "new-file.txt"), "content\n");
        await git.commit(testDir, "Second commit");
        const secondSha = (await Bun.$`git -C ${testDir} rev-parse HEAD`.text()).trim();
  
        const result = await git.isAncestor(testDir, initialSha, secondSha);
        expect(result).toBe(true);
      });
    });

    test("returns false when ref is not an ancestor (diverged)", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const currentBranch = await git.getCurrentBranch(testDir);
  
        // Create two divergent branches
        await git.createBranch(testDir, "branch-a");
        await writeFile(join(testDir, "a-file.txt"), "a content\n");
        await git.commit(testDir, "Commit on branch A");
        const shaA = (await Bun.$`git -C ${testDir} rev-parse HEAD`.text()).trim();
  
        await git.checkoutBranch(testDir, currentBranch);
        await git.createBranch(testDir, "branch-b");
        await writeFile(join(testDir, "b-file.txt"), "b content\n");
        await git.commit(testDir, "Commit on branch B");
        const shaB = (await Bun.$`git -C ${testDir} rev-parse HEAD`.text()).trim();
  
        // Neither is an ancestor of the other
        expect(await git.isAncestor(testDir, shaA, shaB)).toBe(false);
        expect(await git.isAncestor(testDir, shaB, shaA)).toBe(false);

      });

    });

    test("returns true when both refs point to the same commit", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const sha = (await Bun.$`git -C ${testDir} rev-parse HEAD`.text()).trim();
        const result = await git.isAncestor(testDir, sha, sha);
        expect(result).toBe(true);

      });

    });
  });

  describe("mergeWithConflictDetection", () => {
    test("returns success for a clean merge", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        const currentBranch = await git.getCurrentBranch(testDir);
  
        // Create a feature branch with a new file
        await git.createBranch(testDir, "feature-clean");
        await writeFile(join(testDir, "feature.txt"), "feature content\n");
        await git.commit(testDir, "Add feature");
  
        // Go back to the original branch
        await git.checkoutBranch(testDir, currentBranch);
  
        // Merge the feature branch
        const result = await git.mergeWithConflictDetection(testDir, "feature-clean");
        expect(result.success).toBe(true);
        expect(result.alreadyUpToDate).toBe(false);
        expect(result.hasConflicts).toBe(false);
        expect(result.mergeCommitSha).toBeDefined();
        expect(result.mergeCommitSha).toHaveLength(40);
      });
    });

    test("returns alreadyUpToDate when branches have not diverged", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const currentBranch = await git.getCurrentBranch(testDir);
  
        // Create a branch at the same point (no new commits)
        await git.createBranch(testDir, "same-point");
        await git.checkoutBranch(testDir, currentBranch);
  
        const result = await git.mergeWithConflictDetection(testDir, "same-point");
        expect(result.success).toBe(true);
        expect(result.alreadyUpToDate).toBe(true);
        expect(result.hasConflicts).toBe(false);

      });

    });

    test("detects conflicts and returns conflict info", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const currentBranch = await git.getCurrentBranch(testDir);
  
        // Create a feature branch that modifies README.md
        await git.createBranch(testDir, "feature-conflict");
        await writeFile(join(testDir, "README.md"), "# Feature Version\n");
        await git.commit(testDir, "Modify README on feature");
  
        // Go back and modify README.md on the original branch too
        await git.checkoutBranch(testDir, currentBranch);
        await writeFile(join(testDir, "README.md"), "# Main Version\n");
        await git.commit(testDir, "Modify README on main");
  
        // Attempt merge — should conflict
        const result = await git.mergeWithConflictDetection(testDir, "feature-conflict");
        expect(result.success).toBe(false);
        expect(result.alreadyUpToDate).toBe(false);
        expect(result.hasConflicts).toBe(true);
        expect(result.conflictedFiles).toBeDefined();
        expect(result.conflictedFiles).toContain("README.md");

      });

    });

    test("uses custom merge commit message when provided", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const currentBranch = await git.getCurrentBranch(testDir);
  
        await git.createBranch(testDir, "feature-msg");
        await writeFile(join(testDir, "msg-file.txt"), "content\n");
        await git.commit(testDir, "Add file on feature");
  
        await git.checkoutBranch(testDir, currentBranch);
  
        const result = await git.mergeWithConflictDetection(
          testDir,
          "feature-msg",
          "Custom merge message"
        );
        expect(result.success).toBe(true);
  
        // Verify the merge commit message
        const logMsg = (await Bun.$`git -C ${testDir} log -1 --format=%s`.text()).trim();
        expect(logMsg).toBe("Custom merge message");

      });

    });
  });

  describe("abortMerge", () => {
    test("aborts a conflicted merge and restores clean state", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        const currentBranch = await git.getCurrentBranch(testDir);
  
        // Set up a conflict
        await git.createBranch(testDir, "conflict-abort");
        await writeFile(join(testDir, "README.md"), "# Conflict Branch\n");
        await git.commit(testDir, "Change README on conflict branch");
  
        await git.checkoutBranch(testDir, currentBranch);
        await writeFile(join(testDir, "README.md"), "# Original Branch\n");
        await git.commit(testDir, "Change README on original");
  
        // Merge to create conflict
        const mergeResult = await git.mergeWithConflictDetection(testDir, "conflict-abort");
        expect(mergeResult.hasConflicts).toBe(true);
  
        // Abort the merge
        await git.abortMerge(testDir);
  
        // Verify working tree is clean
        const hasChanges = await git.hasUncommittedChanges(testDir);
        expect(hasChanges).toBe(false);
  
        // Verify we're still on the original branch
        const branch = await git.getCurrentBranch(testDir);
        expect(branch).toBe(currentBranch);
  
        // Verify README has the original branch content
        const content = await Bun.file(join(testDir, "README.md")).text();
        expect(content).toBe("# Original Branch\n");
      });
    });

    test("throws when no merge is in progress", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        await expect(git.abortMerge(testDir)).rejects.toThrow();

      });

    });
  });

  describe("getConflictedFiles", () => {
    test("returns empty array when no conflicts", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        void testDir;
        void git;
        const files = await git.getConflictedFiles(testDir);
        expect(files).toEqual([]);
      });
    });

    test("lists conflicted files during a merge conflict", async () => {

      await withGitServiceTest(async (context) => {

        const { testDir, git } = context;

        void testDir;

        void git;
        const currentBranch = await git.getCurrentBranch(testDir);
  
        // Create conflicts in multiple files
        await writeFile(join(testDir, "file-a.txt"), "original a\n");
        await writeFile(join(testDir, "file-b.txt"), "original b\n");
        await git.commit(testDir, "Add original files");
  
        await git.createBranch(testDir, "conflict-files");
        await writeFile(join(testDir, "file-a.txt"), "conflict branch a\n");
        await writeFile(join(testDir, "file-b.txt"), "conflict branch b\n");
        await git.commit(testDir, "Modify files on conflict branch");
  
        await git.checkoutBranch(testDir, currentBranch);
        await writeFile(join(testDir, "file-a.txt"), "main branch a\n");
        await writeFile(join(testDir, "file-b.txt"), "main branch b\n");
        await git.commit(testDir, "Modify files on main");
  
        // Trigger merge conflict
        await git.mergeWithConflictDetection(testDir, "conflict-files");
  
        // Get conflicted files
        const conflictedFiles = await git.getConflictedFiles(testDir);
        expect(conflictedFiles).toContain("file-a.txt");
        expect(conflictedFiles).toContain("file-b.txt");
        expect(conflictedFiles.length).toBe(2);
  
        // Clean up: abort the merge
        await git.abortMerge(testDir);

      });

    });
  });

  describe("getLastCommitMessage", () => {
    test("returns the subject line of the most recent commit", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        await writeFile(join(testDir, "feature.txt"), "New feature\n");
        await Bun.$`git -C ${testDir} add -A`.quiet();
        await Bun.$`git -C ${testDir} commit -m "feat(auth): add JWT token refresh"`.quiet();

        const message = await git.getLastCommitMessage(testDir);
        expect(message).toBe("feat(auth): add JWT token refresh");
      });
    });

    test("returns the initial commit message when no other commits exist", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        const message = await git.getLastCommitMessage(testDir);
        expect(message).toBe("Initial commit");
      });
    });

    test("returns only the subject line for multi-line commit messages", async () => {
      await withGitServiceTest(async (context) => {
        const { testDir, git } = context;
        await writeFile(join(testDir, "fix.txt"), "Bug fix\n");
        await Bun.$`git -C ${testDir} add -A`.quiet();
        await Bun.$`git -C ${testDir} commit -m ${"fix: resolve crash\n\nThis fixes the crash that occurred on startup."}`.quiet();

        const message = await git.getLastCommitMessage(testDir);
        expect(message).toBe("fix: resolve crash");
      });
    });
  });
});
