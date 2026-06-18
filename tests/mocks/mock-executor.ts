/**
 * Mock command executor for testing.
 * Runs commands locally using Bun.spawn and Bun.file APIs.
 * This is only used in tests - production code uses CommandExecutorImpl via PTY.
 */

import { createWriteStream } from "node:fs";
import { mkdir, readdir, stat, truncate } from "node:fs/promises";
import type {
  CommandExecutor,
  CommandResult,
  CommandOptions,
  FileStreamOptions,
  FileWriteStreamOptions,
  FileWriteStreamResult,
} from "../../src/core/command-executor";

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

  async streamFile(path: string, _options?: FileStreamOptions): Promise<ReadableStream<Uint8Array> | null> {
    try {
      const fileStat = await stat(path);
      if (!fileStat.isFile()) {
        return null;
      }
      return Bun.file(path).stream();
    } catch {
      return null;
    }
  }

  async writeFileStream(
    path: string,
    stream: ReadableStream<Uint8Array>,
    options?: FileWriteStreamOptions,
  ): Promise<FileWriteStreamResult> {
    try {
      if (options?.signal?.aborted) {
        return { success: false, bytesWritten: 0, error: "Write aborted" };
      }

      const dir = path.substring(0, path.lastIndexOf("/"));
      if (dir) {
        await mkdir(dir, { recursive: true });
      }

      const expectedOffset = options?.expectedOffset;
      if (expectedOffset !== undefined) {
        let currentSize = 0;
        try {
          currentSize = (await stat(path)).size;
        } catch {
          currentSize = 0;
        }
        if (options?.append && currentSize > expectedOffset) {
          await truncate(path, expectedOffset);
          currentSize = expectedOffset;
        }
        if (currentSize !== expectedOffset) {
          return {
            success: false,
            bytesWritten: 0,
            error: `Expected file offset ${expectedOffset}, found ${currentSize}`,
          };
        }
      }

      const writeStream = createWriteStream(path, {
        flags: options?.append && expectedOffset !== 0 ? "r+" : "w",
        ...(options?.append ? { start: expectedOffset ?? 0 } : {}),
      });
      const reader = stream.getReader();
      let bytesWritten = 0;
      try {
        while (true) {
          if (options?.signal?.aborted) {
            return { success: false, bytesWritten, error: "Write aborted" };
          }
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          const canContinue = writeStream.write(value);
          bytesWritten += value.byteLength;
          if (!canContinue) {
            await new Promise<void>((resolve, reject) => {
              writeStream.once("drain", resolve);
              writeStream.once("error", reject);
            });
          }
        }
      } finally {
        await new Promise<void>((resolve, reject) => {
          writeStream.end(() => resolve());
          writeStream.once("error", reject);
        });
      }
      return { success: true, bytesWritten };
    } catch (error) {
      return {
        success: false,
        bytesWritten: 0,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      };
    }
  }

  async copyFile(sourcePath: string, destinationPath: string): Promise<boolean> {
    try {
      const dir = destinationPath.substring(0, destinationPath.lastIndexOf("/"));
      if (dir) {
        await mkdir(dir, { recursive: true });
      }
      const source = Bun.file(sourcePath);
      if (!(await source.exists())) {
        return false;
      }
      await Bun.write(destinationPath, source);
      return true;
    } catch {
      return false;
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
