/**
 * Unit tests for diff parsing logic, especially line ending handling.
 * These tests verify that CRLF line endings from PTY are handled correctly.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { GitService } from "../../src/core/git-service";
import type { CommandExecutor, CommandResult, CommandOptions } from "../../src/core/command-executor";

/**
 * Mock executor that simulates PTY output with CRLF line endings.
 * This mimics what we get from real command execution output.
 */
class CRLFCommandExecutor implements CommandExecutor {
  private realExecutor: CommandExecutor;
  private convertToCRLF: boolean;

  constructor(convertToCRLF = true) {
    this.convertToCRLF = convertToCRLF;
    // Use real execution but convert output
    this.realExecutor = {
      exec: async (command: string, args: string[], options?: CommandOptions): Promise<CommandResult> => {
        const cwd = options?.cwd ?? ".";
        const result = await Bun.$`${command} ${args}`.cwd(cwd).quiet();
        return {
          success: result.exitCode === 0,
          stdout: result.stdout.toString(),
          stderr: result.stderr.toString(),
          exitCode: result.exitCode,
        };
      },
      fileExists: async () => false,
      directoryExists: async () => false,
      readFile: async () => null,
      listDirectory: async () => [],
      writeFile: async () => false,
    };
  }

  async exec(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
    const result = await this.realExecutor.exec(command, args, options);
    
    // Convert LF to CRLF to simulate PTY output
    if (this.convertToCRLF) {
      return {
        ...result,
        stdout: result.stdout.replace(/\n/g, "\r\n"),
        stderr: result.stderr.replace(/\n/g, "\r\n"),
      };
    }
    
    return result;
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

describe("Diff parsing with CRLF line endings", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "clanky-diff-test-"));
    
    // Initialize git repo
    await Bun.$`git init ${testDir}`.quiet();
    await Bun.$`git -C ${testDir} config user.email "test@test.com"`.quiet();
    await Bun.$`git -C ${testDir} config user.name "Test User"`.quiet();
    
    // Create initial commit
    await writeFile(join(testDir, "README.md"), "# Test\n");
    await Bun.$`git -C ${testDir} add -A`.quiet();
    await Bun.$`git -C ${testDir} commit -m "Initial commit"`.quiet();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true });
  });

  describe("getDiffWithContent with CRLF output", () => {
    test("correctly parses diff when output has CRLF line endings", async () => {
      const executor = new CRLFCommandExecutor(true);
      const git = new GitService(executor);
      
      // Get original branch
      const originalBranch = (await Bun.$`git -C ${testDir} rev-parse --abbrev-ref HEAD`.quiet()).stdout.toString().trim();
      
      // Create feature branch with changes
      await Bun.$`git -C ${testDir} checkout -b feature-crlf`.quiet();
      await writeFile(join(testDir, "new-file.txt"), "Hello World\nLine 2\n");
      await Bun.$`git -C ${testDir} add -A`.quiet();
      await Bun.$`git -C ${testDir} commit -m "Add new file"`.quiet();
      
      // Get diff with CRLF executor
      const diffs = await git.getDiffWithContent(testDir, originalBranch);
      
      expect(diffs.length).toBe(1);
      expect(diffs[0]?.path).toBe("new-file.txt");
      expect(diffs[0]?.patch).toBeDefined();
      expect(diffs[0]?.patch).toContain("diff --git");
      expect(diffs[0]?.patch).toContain("+Hello World");
    });

    test("correctly parses multiple file diffs with CRLF line endings", async () => {
      const executor = new CRLFCommandExecutor(true);
      const git = new GitService(executor);
      
      const originalBranch = (await Bun.$`git -C ${testDir} rev-parse --abbrev-ref HEAD`.quiet()).stdout.toString().trim();
      
      await Bun.$`git -C ${testDir} checkout -b feature-multi-crlf`.quiet();
      await writeFile(join(testDir, "file1.txt"), "Content 1\n");
      await writeFile(join(testDir, "file2.txt"), "Content 2\n");
      await writeFile(join(testDir, "file3.txt"), "Content 3\n");
      await Bun.$`git -C ${testDir} add -A`.quiet();
      await Bun.$`git -C ${testDir} commit -m "Add files"`.quiet();
      
      const diffs = await git.getDiffWithContent(testDir, originalBranch);
      
      expect(diffs.length).toBe(3);
      
      // All files should have patches even with CRLF
      for (const diff of diffs) {
        expect(diff.patch).toBeDefined();
        expect(diff.patch).toContain("diff --git");
      }
      
      const file1 = diffs.find(d => d.path === "file1.txt");
      const file2 = diffs.find(d => d.path === "file2.txt");
      const file3 = diffs.find(d => d.path === "file3.txt");
      
      expect(file1?.patch).toContain("+Content 1");
      expect(file2?.patch).toContain("+Content 2");
      expect(file3?.patch).toContain("+Content 3");
    });

    test("handles nested paths with CRLF line endings", async () => {
      const executor = new CRLFCommandExecutor(true);
      const git = new GitService(executor);
      
      const originalBranch = (await Bun.$`git -C ${testDir} rev-parse --abbrev-ref HEAD`.quiet()).stdout.toString().trim();
      
      await Bun.$`git -C ${testDir} checkout -b feature-nested-crlf`.quiet();
      await Bun.$`mkdir -p ${join(testDir, "src/components")}`.quiet();
      await writeFile(join(testDir, "src/components/Button.tsx"), "export const Button = () => <button>Click</button>;\n");
      await Bun.$`git -C ${testDir} add -A`.quiet();
      await Bun.$`git -C ${testDir} commit -m "Add component"`.quiet();
      
      const diffs = await git.getDiffWithContent(testDir, originalBranch);
      
      expect(diffs.length).toBe(1);
      expect(diffs[0]?.path).toBe("src/components/Button.tsx");
      expect(diffs[0]?.patch).toBeDefined();
      expect(diffs[0]?.patch).toContain("diff --git");
      expect(diffs[0]?.patch).toContain("+export const Button");
    });
  });

  describe("getDiff with CRLF output", () => {
    test("correctly parses numstat output with CRLF", async () => {
      const executor = new CRLFCommandExecutor(true);
      const git = new GitService(executor);
      
      const originalBranch = (await Bun.$`git -C ${testDir} rev-parse --abbrev-ref HEAD`.quiet()).stdout.toString().trim();
      
      await Bun.$`git -C ${testDir} checkout -b feature-numstat-crlf`.quiet();
      await writeFile(join(testDir, "new-file.txt"), "Line 1\nLine 2\nLine 3\n");
      await Bun.$`git -C ${testDir} add -A`.quiet();
      await Bun.$`git -C ${testDir} commit -m "Add file"`.quiet();
      
      const diffs = await git.getDiff(testDir, originalBranch);
      
      expect(diffs.length).toBe(1);
      expect(diffs[0]?.path).toBe("new-file.txt");
      expect(diffs[0]?.status).toBe("added");
      expect(diffs[0]?.additions).toBe(3);
    });
  });

  describe("Comparison: LF vs CRLF output", () => {
    test("produces identical results regardless of line ending style", async () => {
      // Setup: create a branch with changes
      const originalBranch = (await Bun.$`git -C ${testDir} rev-parse --abbrev-ref HEAD`.quiet()).stdout.toString().trim();
      
      await Bun.$`git -C ${testDir} checkout -b feature-compare`.quiet();
      await writeFile(join(testDir, "test-file.txt"), "Test content\nMore content\n");
      await Bun.$`git -C ${testDir} add -A`.quiet();
      await Bun.$`git -C ${testDir} commit -m "Add test file"`.quiet();
      
      // Get diffs with LF executor (normal)
      const lfExecutor = new CRLFCommandExecutor(false);
      const lfGit = new GitService(lfExecutor);
      const lfDiffs = await lfGit.getDiffWithContent(testDir, originalBranch);
      
      // Get diffs with CRLF executor (simulated PTY)
      const crlfExecutor = new CRLFCommandExecutor(true);
      const crlfGit = new GitService(crlfExecutor);
      const crlfDiffs = await crlfGit.getDiffWithContent(testDir, originalBranch);
      
      // Results should be equivalent
      expect(crlfDiffs.length).toBe(lfDiffs.length);
      expect(crlfDiffs[0]?.path).toBe(lfDiffs[0]?.path);
      expect(crlfDiffs[0]?.status).toBe(lfDiffs[0]?.status);
      expect(crlfDiffs[0]?.additions).toBe(lfDiffs[0]?.additions);
      expect(crlfDiffs[0]?.deletions).toBe(lfDiffs[0]?.deletions);
      
      // Both should have patches defined
      expect(crlfDiffs[0]?.patch).toBeDefined();
      expect(lfDiffs[0]?.patch).toBeDefined();
      
      // Patches should contain the same content (after normalizing line endings)
      const normalizedCrlfPatch = crlfDiffs[0]?.patch?.replace(/\r\n/g, "\n");
      const normalizedLfPatch = lfDiffs[0]?.patch?.replace(/\r\n/g, "\n");
      expect(normalizedCrlfPatch).toBe(normalizedLfPatch);
    });
  });
});
