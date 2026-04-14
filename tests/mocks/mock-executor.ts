/**
 * Mock command executor for testing.
 * Runs commands locally using Bun.spawn and Bun.file APIs.
 * This is only used in tests - production code uses CommandExecutorImpl via PTY.
 */

import { mkdir, readdir } from "node:fs/promises";
import type { CommandExecutor, CommandResult, CommandOptions } from "../../src/core/command-executor";

/**
 * TestCommandExecutor runs commands locally for testing purposes.
 * Uses Bun.spawn for shell commands and Bun.file for file operations.
 */
export class TestCommandExecutor implements CommandExecutor {
  /**
   * Execute a shell command locally.
   */
  async exec(command: string, args: string[], options?: CommandOptions): Promise<CommandResult> {
    try {
      const cwd = options?.cwd ?? process.cwd();
      if (options?.signal?.aborted) {
        return {
          success: false,
          stdout: "",
          stderr: "Command aborted",
          exitCode: 130,
        };
      }

      // Use Bun.spawn which handles cwd more reliably than Bun.$
      const executable = Bun.which(command) ?? command;
      const proc = Bun.spawn([executable, ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, ...(options?.env ?? {}) },
      });

      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      options?.onStdoutChunk?.(stdout);
      options?.onStderrChunk?.(stderr);
      
      return {
        success: exitCode === 0,
        stdout,
        stderr,
        exitCode,
      };
    } catch (error) {
      return {
        success: false,
        stdout: "",
        stderr: String(error),
        exitCode: 1,
      };
    }
  }

  /**
   * Check if a file exists locally.
   */
  async fileExists(path: string): Promise<boolean> {
    return Bun.file(path).exists();
  }

  /**
   * Check if a directory exists locally.
   */
  async directoryExists(path: string): Promise<boolean> {
    try {
      const entries = await readdir(path);
      // If readdir succeeds, it's a directory
      return entries !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Read a file's contents locally.
   */
  async readFile(path: string): Promise<string | null> {
    try {
      const file = Bun.file(path);
      if (!(await file.exists())) {
        return null;
      }
      return await file.text();
    } catch {
      return null;
    }
  }

  /**
   * List files in a directory locally.
   */
  async listDirectory(path: string, options?: { includeHidden?: boolean }): Promise<string[]> {
    try {
      const entries = await readdir(path);
      return (options?.includeHidden ?? false) ? entries : entries.filter((entry) => !entry.startsWith("."));
    } catch {
      return [];
    }
  }

  /**
   * Write content to a file locally.
   */
  async writeFile(path: string, content: string): Promise<boolean> {
    try {
      // Ensure parent directory exists
      const dir = path.substring(0, path.lastIndexOf("/"));
      if (dir) {
        await mkdir(dir, { recursive: true });
      }
      await Bun.write(path, content);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Singleton instance for convenience in tests.
 */
export const testCommandExecutor = new TestCommandExecutor();
