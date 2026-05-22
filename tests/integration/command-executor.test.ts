/**
 * Integration tests for CommandExecutorImpl.
 * 
 * These tests verify the command execution logic and marker parsing.
 * They use the TestCommandExecutor for local execution, which validates
 * the same code paths as the real command executor.
 * 
 * For true end-to-end testing with a real opencode server, see the
 * manual test scripts in the .clanky-planning folder.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { TestCommandExecutor } from "../mocks/mock-executor";

describe("CommandExecutor Integration", () => {
  let testDir: string;
  let executor: TestCommandExecutor;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), "clanky-cmd-test-"));
    executor = new TestCommandExecutor();
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true });
  });

  describe("exec", () => {
    test("executes simple echo command", async () => {
      const result = await executor.exec("echo", ["hello world"], { cwd: testDir });
      
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("hello world");
      expect(result.stderr).toBe("");
    });

    test("executes command with multiple arguments", async () => {
      const result = await executor.exec("echo", ["-n", "no newline"], { cwd: testDir });
      
      expect(result.success).toBe(true);
      expect(result.stdout).toBe("no newline");
    });

    test("captures stderr on failure", async () => {
      const result = await executor.exec("ls", ["nonexistent-file-12345"], { cwd: testDir });
      
      expect(result.success).toBe(false);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("nonexistent");
    });

    test("handles command not found", async () => {
      const result = await executor.exec("nonexistent-command-12345", [], { cwd: testDir });
      
      expect(result.success).toBe(false);
      expect(result.exitCode).not.toBe(0);
    });

    test("respects cwd option", async () => {
      const subDir = join(testDir, "subdir");
      await mkdir(subDir);
      await writeFile(join(subDir, "test.txt"), "content");
      
      const result = await executor.exec("ls", [], { cwd: subDir });
      
      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe("test.txt");
    });

    test("handles special characters in arguments", async () => {
      const specialString = "hello 'world' \"test\" $VAR";
      await writeFile(join(testDir, "special.txt"), specialString);
      
      const result = await executor.exec("cat", ["special.txt"], { cwd: testDir });
      
      expect(result.success).toBe(true);
      expect(result.stdout).toBe(specialString);
    });
  });

  describe("git commands", () => {
    beforeEach(async () => {
      // Initialize git repo for git-specific tests
      await Bun.$`git init`.cwd(testDir).quiet();
      await Bun.$`git config user.email "test@test.com"`.cwd(testDir).quiet();
      await Bun.$`git config user.name "Test User"`.cwd(testDir).quiet();
      await writeFile(join(testDir, ".gitkeep"), "");
      await Bun.$`git add .`.cwd(testDir).quiet();
      await Bun.$`git commit -m "Initial commit"`.cwd(testDir).quiet();
    });

    test("git status with no changes", async () => {
      const result = await executor.exec("git", ["status", "--porcelain"], { cwd: testDir });
      
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe("");
    });

    test("git status with changes", async () => {
      await writeFile(join(testDir, "new-file.txt"), "content");
      
      const result = await executor.exec("git", ["status", "--porcelain"], { cwd: testDir });
      
      expect(result.success).toBe(true);
      expect(result.stdout).toContain("new-file.txt");
    });

    test("git branch listing", async () => {
      const result = await executor.exec("git", ["branch", "--format=%(refname:short)|%(HEAD)"], { cwd: testDir });
      
      expect(result.success).toBe(true);
      // Should have main or master branch
      expect(result.stdout).toMatch(/^(main|master)\|\*$/m);
    });

    test("git rev-parse for current branch", async () => {
      const result = await executor.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: testDir });
      
      expect(result.success).toBe(true);
      expect(["main", "master"]).toContain(result.stdout.trim());
    });

    test("git checkout -b creates new branch", async () => {
      const result = await executor.exec("git", ["checkout", "-b", "test-branch"], { cwd: testDir });
      
      expect(result.success).toBe(true);
      
      // Verify we're on the new branch
      const branchResult = await executor.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: testDir });
      expect(branchResult.stdout.trim()).toBe("test-branch");
    });
  });

  describe("file operations", () => {
    test("fileExists returns true for existing file", async () => {
      const filePath = join(testDir, "exists.txt");
      await writeFile(filePath, "content");
      
      const exists = await executor.fileExists(filePath);
      expect(exists).toBe(true);
    });

    test("fileExists returns false for non-existing file", async () => {
      const filePath = join(testDir, "does-not-exist.txt");
      
      const exists = await executor.fileExists(filePath);
      expect(exists).toBe(false);
    });

    test("directoryExists returns true for existing directory", async () => {
      const exists = await executor.directoryExists(testDir);
      expect(exists).toBe(true);
    });

    test("directoryExists returns false for non-existing directory", async () => {
      const exists = await executor.directoryExists(join(testDir, "nonexistent"));
      expect(exists).toBe(false);
    });

    test("readFile returns file contents", async () => {
      const filePath = join(testDir, "read-me.txt");
      await writeFile(filePath, "file content here");
      
      const content = await executor.readFile(filePath);
      expect(content).toBe("file content here");
    });

    test("readFile returns null for non-existing file", async () => {
      const content = await executor.readFile(join(testDir, "does-not-exist.txt"));
      expect(content).toBeNull();
    });

    test("listDirectory hides hidden entries by default", async () => {
      await writeFile(join(testDir, "a.txt"), "");
      await writeFile(join(testDir, "b.txt"), "");
      await writeFile(join(testDir, ".env"), "");
      await mkdir(join(testDir, "subdir"));
      
      const files = await executor.listDirectory(testDir);
      expect(files).toContain("a.txt");
      expect(files).toContain("b.txt");
      expect(files).toContain("subdir");
      expect(files).not.toContain(".env");
    });

    test("listDirectory can include hidden entries explicitly", async () => {
      await writeFile(join(testDir, ".env"), "");

      const files = await executor.listDirectory(testDir, { includeHidden: true });

      expect(files).toContain(".env");
    });

    test("listDirectory returns empty array for non-existing directory", async () => {
      const files = await executor.listDirectory(join(testDir, "nonexistent"));
      expect(files).toEqual([]);
    });
  });
});

describe("Marker Parsing Logic", () => {
  /**
   * These tests verify the marker extraction logic that's used in CommandExecutorImpl.
   * The same logic is tested here independently to ensure it works correctly.
   */

  function extractOutputBetweenMarkers(
    output: string,
    startMarker: string,
    endMarker: string
  ): string {
    // Find the LAST occurrence of markers (actual echo output, not command echo)
    const startMarkerWithNewline = startMarker + "\r\n";
    const lastStartIndex = output.lastIndexOf(startMarkerWithNewline);
    const lastEndIndex = output.lastIndexOf(endMarker + ":");

    if (lastStartIndex !== -1 && lastEndIndex !== -1 && lastEndIndex > lastStartIndex) {
      const contentStart = lastStartIndex + startMarkerWithNewline.length;
      return output.slice(contentStart, lastEndIndex).trim();
    }

    // Fallback: try with just newline
    const startAfterNewline = output.lastIndexOf("\n" + startMarker);
    const endAfterNewline = output.lastIndexOf("\n" + endMarker);

    if (startAfterNewline !== -1 && endAfterNewline !== -1 && endAfterNewline > startAfterNewline) {
      const contentStart = startAfterNewline + 1 + startMarker.length;
      return output.slice(contentStart, endAfterNewline).trim();
    }

    // Last resort: use first occurrence
    const startIndex = output.indexOf(startMarker);
    const endIndex = output.indexOf(endMarker);

    if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
      return output.slice(startIndex + startMarker.length, endIndex).trim();
    }

    return "";
  }

  const startMarker = "__CLANKY_START_test123__";
  const endMarker = "__CLANKY_END_test123__";

  test("extracts content between markers with \\r\\n", () => {
    const output = `some noise\r\n${startMarker}\r\nactual content\r\n${endMarker}:0\r\nmore noise`;
    
    const extracted = extractOutputBetweenMarkers(output, startMarker, endMarker);
    expect(extracted).toBe("actual content");
  });

  test("extracts content between markers with \\n", () => {
    const output = `some noise\n${startMarker}\nactual content\n${endMarker}:0\nmore noise`;
    
    const extracted = extractOutputBetweenMarkers(output, startMarker, endMarker);
    expect(extracted).toBe("actual content");
  });

  test("handles multiline content", () => {
    const output = `${startMarker}\r\nline 1\r\nline 2\r\nline 3\r\n${endMarker}:0`;
    
    const extracted = extractOutputBetweenMarkers(output, startMarker, endMarker);
    expect(extracted).toBe("line 1\r\nline 2\r\nline 3");
  });

  test("uses last occurrence of markers (handles PTY echo)", () => {
    // PTY echoes the command, so markers appear twice:
    // 1. First time in the command echo
    // 2. Second time in the actual output
    const output = [
      `echo "${startMarker}"`, // Command echo (should be ignored)
      `${startMarker}\r\n`,    // Actual start marker output
      "real content",
      `${endMarker}:0`,        // Actual end marker output
    ].join("\r\n");
    
    const extracted = extractOutputBetweenMarkers(output, startMarker, endMarker);
    expect(extracted).toBe("real content");
  });

  test("returns empty string when markers not found", () => {
    const output = "no markers here";
    
    const extracted = extractOutputBetweenMarkers(output, startMarker, endMarker);
    expect(extracted).toBe("");
  });

  test("returns empty string when end marker is before start marker", () => {
    const output = `${endMarker}:0\r\n${startMarker}\r\ncontent`;
    
    const extracted = extractOutputBetweenMarkers(output, startMarker, endMarker);
    expect(extracted).toBe("");
  });

  test("trims whitespace from extracted content", () => {
    const output = `${startMarker}\r\n   padded content   \r\n${endMarker}:0`;
    
    const extracted = extractOutputBetweenMarkers(output, startMarker, endMarker);
    expect(extracted).toBe("padded content");
  });
});
