import { log } from "@pablozaiden/webapp/server";
import type { AcpAuthenticationMode, AcpProcessExit } from "./types";

export type AcpProcessStream = "stdout" | "stderr";

export interface AcpProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  authenticationMode?: AcpAuthenticationMode;
  env?: NodeJS.ProcessEnv;
  onLine: (source: AcpProcessStream, line: string) => void;
  onExit: (exit: AcpProcessExit) => void;
  onStreamError?: (source: AcpProcessStream, error: unknown) => void;
  maxBufferedBytes?: number;
  maxLineBytes?: number;
  onOutputLimitExceeded?: (source: AcpProcessStream) => void;
}

export interface AcpProcessStopOptions {
  gracefulWaitMs?: number;
  forceWaitMs?: number;
}

const DEFAULT_GRACEFUL_WAIT_MS = 250;
const DEFAULT_FORCE_WAIT_MS = 1_000;

export class AcpProcess {
  private closed = false;
  private started = false;

  private constructor(
    private readonly child: Bun.Subprocess,
    private readonly options: AcpProcessOptions,
  ) {}

  static async spawn(options: AcpProcessOptions): Promise<AcpProcess> {
    const child = Bun.spawn([options.command, ...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (
      !child.stdin
      || typeof child.stdin === "number"
      || !child.stdout
      || typeof child.stdout === "number"
    ) {
      await terminateAcpProcess(child);
      throw new Error("The ACP process did not expose usable streams.");
    }

    return new AcpProcess(child, options);
  }

  getChild(): Bun.Subprocess {
    return this.child;
  }

  get exitCode(): number | null {
    return this.child.exitCode;
  }

  get signalCode(): NodeJS.Signals | null {
    return this.child.signalCode;
  }

  isWritable(): boolean {
    return !!this.child.stdin && typeof this.child.stdin !== "number";
  }

  write(value: string): void {
    if (!this.child.stdin || typeof this.child.stdin === "number") {
      throw new Error("ACP process stdin is not writable.");
    }
    this.child.stdin.write(value);
  }

  start(): void {
    if (this.started || this.closed) {
      return;
    }
    this.started = true;
    this.startReaders();
  }

  async stop(options: AcpProcessStopOptions = {}): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await terminateAcpProcess(this.child, options);
  }

  private startReaders(): void {
    if (this.child.stdout && typeof this.child.stdout !== "number") {
      void this.readStream(this.child.stdout, "stdout");
    }
    if (this.child.stderr && typeof this.child.stderr !== "number") {
      void this.readStream(this.child.stderr, "stderr");
    }
    void this.child.exited.then((exitCode) => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      this.options.onExit({
        exitCode,
        signalCode: this.child.signalCode,
      });
    });
  }

  private async readStream(
    stream: ReadableStream<Uint8Array>,
    source: AcpProcessStream,
  ): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        if (this.exceedsLimit(buffer, source, this.options.maxBufferedBytes)) {
          return;
        }

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line && !this.emitLine(source, line)) {
            return;
          }
          newlineIndex = buffer.indexOf("\n");
        }
      }

      const rest = buffer.trim();
      if (rest) {
        this.emitLine(source, rest);
      }
    } catch (error) {
      if (!this.closed) {
        this.options.onStreamError?.(source, error);
        if (!this.options.onStreamError) {
          log.warn("ACP process stream ended with an error", {
            source,
            error: String(error),
          });
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private emitLine(source: AcpProcessStream, line: string): boolean {
    if (this.closed) {
      return false;
    }
    if (this.exceedsLimit(line, source, this.options.maxLineBytes)) {
      return false;
    }
    this.options.onLine(source, line);
    return !this.closed;
  }

  private exceedsLimit(
    value: string,
    source: AcpProcessStream,
    limit: number | undefined,
  ): boolean {
    if (limit === undefined || Buffer.byteLength(value, "utf8") <= limit) {
      return false;
    }
    this.options.onOutputLimitExceeded?.(source);
    return true;
  }
}

export async function terminateAcpProcess(
  process: Bun.Subprocess | null,
  options: AcpProcessStopOptions = {},
): Promise<void> {
  if (!process || process.exitCode !== null) {
    return;
  }

  try {
    process.kill("SIGTERM");
  } catch (error) {
    log.debug("Failed to send SIGTERM while stopping ACP process", {
      error: String(error),
    });
  }

  const exitedAfterTerminate = await waitForAcpProcessExit(
    process,
    options.gracefulWaitMs ?? DEFAULT_GRACEFUL_WAIT_MS,
  );
  if (exitedAfterTerminate) {
    return;
  }

  try {
    process.kill("SIGKILL");
  } catch (error) {
    log.debug("Failed to send SIGKILL while stopping ACP process", {
      error: String(error),
    });
  }

  await waitForAcpProcessExit(
    process,
    options.forceWaitMs ?? DEFAULT_FORCE_WAIT_MS,
  );
}

async function waitForAcpProcessExit(
  process: Bun.Subprocess,
  timeoutMs: number,
): Promise<boolean> {
  if (process.exitCode !== null) {
    return true;
  }
  if (timeoutMs <= 0) {
    return process.exitCode !== null;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exited = await Promise.race<boolean>([
      process.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    return exited || process.exitCode !== null;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
