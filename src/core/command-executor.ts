/**
 * Command execution abstraction for Clanky Tasks Management System.
 * Provides a unified interface for running shell commands and file operations
 * that works both locally (`stdio` transport) and remotely (`ssh` transport).
 */

/**
 * Result of a command execution.
 */
export interface CommandResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Options for command execution.
 */
export interface CommandOptions {
  /** Working directory for the command */
  cwd?: string;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Whether failed commands should be logged by the executor */
  logFailures?: boolean;
  /** Environment variable overrides for the command */
  env?: Record<string, string>;
  /** Abort signal for cancelling the running process */
  signal?: AbortSignal;
  /** Optional callback for incremental stdout chunks */
  onStdoutChunk?: (chunk: string) => void;
  /** Optional callback for incremental stderr chunks */
  onStderrChunk?: (chunk: string) => void;
}

export interface FileStreamOptions {
  /** Abort signal for cancelling the file stream */
  signal?: AbortSignal;
}

export interface FileWriteStreamOptions {
  /** Abort signal for cancelling the file write */
  signal?: AbortSignal;
  /** Append to an existing file instead of replacing it */
  append?: boolean;
  /** Expected file size before writing; rejects when the current size differs */
  expectedOffset?: number;
}

export interface FileWriteStreamResult {
  success: boolean;
  bytesWritten: number;
  error?: string;
}

/**
 * CommandExecutor interface for running shell commands and file operations.
 * Implementation: CommandExecutorImpl executes commands via local or SSH providers.
 * Commands are queued to ensure only one runs at a time.
 */
export interface CommandExecutor {
  /**
   * Execute a shell command.
   * @param command - The command to execute (e.g., "git status")
   * @param args - Arguments to pass to the command
   * @param options - Execution options (cwd, timeout, env overrides)
   * @returns The command result with stdout, stderr, and exit code
   */
  exec(command: string, args: string[], options?: CommandOptions): Promise<CommandResult>;

  /**
   * Check if a file exists.
   * @param path - Absolute path to the file
   * @returns true if the file exists
   */
  fileExists(path: string): Promise<boolean>;

  /**
   * Check if a directory exists.
   * @param path - Absolute path to the directory
   * @returns true if the directory exists
   */
  directoryExists(path: string): Promise<boolean>;

  /**
   * Read a file's contents.
   * @param path - Absolute path to the file
   * @returns The file contents, or null if the file doesn't exist
   */
  readFile(path: string): Promise<string | null>;

  /**
   * Stream a file's raw bytes without buffering the full file in memory.
   * @param path - Absolute path to the file
   * @param options - Streaming options
   * @returns A byte stream, or null if the file cannot be streamed
   */
  streamFile(path: string, options?: FileStreamOptions): Promise<ReadableStream<Uint8Array> | null>;

  /**
   * Write raw bytes from a stream without buffering the full content in memory.
   * @param path - Absolute path to the file
   * @param stream - Byte stream to write
   * @param options - Streaming write options
   */
  writeFileStream?(
    path: string,
    stream: ReadableStream<Uint8Array>,
    options?: FileWriteStreamOptions,
  ): Promise<FileWriteStreamResult>;

  /**
   * Copy a file on the execution host without streaming contents through Clanky.
   * @param sourcePath - Absolute path to the source file
   * @param destinationPath - Absolute path to the destination file
   * @returns true if the copy was successful
   */
  copyFile?(sourcePath: string, destinationPath: string): Promise<boolean>;

  /**
   * List files in a directory.
   * @param path - Absolute path to the directory
   * @param options - Listing options
   * @returns Array of file/directory names in the directory
   */
  listDirectory(path: string, options?: { includeHidden?: boolean }): Promise<string[]>;

  /**
   * Write content to a file on the server.
   * Creates the file if it doesn't exist, overwrites if it does.
   * Uses base64 encoding to safely transfer content with special characters.
   * @param path - Absolute path to the file
   * @param content - The content to write
   * @returns true if the write was successful
   */
  writeFile(path: string, content: string): Promise<boolean>;
}
