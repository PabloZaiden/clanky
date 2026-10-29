/**
 * Owns one attached app-server process and its single deterministic teardown.
 */

import { HarnessError } from "../harness-errors";
import { CodexRpcSession } from "./rpc-session";
import { MESSAGE_ATTACHMENT_MAX_PROMPT_BYTES } from "@/shared/message-attachments";
import { version } from "../../../package.json";

const MAX_FRAME_BYTES = MESSAGE_ATTACHMENT_MAX_PROMPT_BYTES;

export class CodexRuntime {
  readonly rpc: CodexRpcSession;
  private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly reader: Promise<void>;
  private readonly stderr: Promise<void>;
  private closing?: Promise<void>;
  private readonly failures = new Set<(error: Error) => void>();

  private constructor(readonly directory: string, executable: string, env?: NodeJS.ProcessEnv) {
    this.process = Bun.spawn([executable, "-c", "analytics.enabled=false", "app-server", "--stdio"], {
      cwd: directory, env: { ...process.env, ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    this.rpc = new CodexRpcSession(async (frame: string) => {
      this.process.stdin.write(`${frame}\n`);
      await this.process.stdin.flush();
    });
    this.reader = this.readFrames();
    const subprocess = this.process;
    this.stderr = (async () => {
      // Drain without retaining potentially sensitive provider diagnostics.
      for await (const _chunk of subprocess.stderr) {}
    })();
  }

  static async open(options: { directory: string; env?: NodeJS.ProcessEnv }, signal?: AbortSignal): Promise<CodexRuntime> {
    if (signal?.aborted) throw new HarnessError("harness_connection_aborted", "Codex startup was cancelled.");
    const executable = Bun.which("codex", { PATH: options.env?.["PATH"] ?? process.env["PATH"], cwd: options.directory });
    if (!executable) throw new HarnessError("harness_runtime_unavailable", "Codex CLI is not installed on the execution host.");
    if (signal?.aborted) throw new HarnessError("harness_connection_aborted", "Codex startup was cancelled.");
    const runtime = new CodexRuntime(options.directory, executable, options.env);
    const abort = Promise.withResolvers<never>();
    const onAbort = (): void => abort.reject(new HarnessError("harness_connection_aborted", "Codex startup was cancelled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([
        runtime.rpc.request("initialize", {
          clientInfo: { name: "clanky", version, title: "Clanky" },
          capabilities: { experimentalApi: true, requestAttestation: false },
        }), abort.promise,
      ]);
      if (signal?.aborted) onAbort();
      if (signal?.aborted) throw new HarnessError("harness_connection_aborted", "Codex startup was cancelled.");
      await runtime.rpc.initialized();
      return runtime;
    } catch (error) {
      try { await runtime.close(); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Codex startup and cleanup failed.");
      }
      throw error;
    } finally { signal?.removeEventListener("abort", onAbort); }
  }

  isOpen(): boolean { return !this.closing && this.process.exitCode === null && this.rpc.isOpen(); }

  onFailure(listener: (error: Error) => void): () => void {
    this.failures.add(listener);
    return () => this.failures.delete(listener);
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.rpc.close();
      this.process.stdin.end();
      const escalation = setTimeout(() => this.process.kill("SIGTERM"), 5_000);
      const force = setTimeout(() => this.process.kill("SIGKILL"), 10_000);
      try { await this.process.exited; } finally {
        clearTimeout(escalation);
        clearTimeout(force);
      }
      await Promise.all([this.reader, this.stderr]);
      this.failures.clear();
    })();
    return this.closing;
  }

  private async readFrames(): Promise<void> {
    const decoder = new TextDecoder();
    let parts: Uint8Array[] = [];
    let bytes = 0;
    try {
      for await (const chunk of this.process.stdout) {
        let start = 0;
        while (start < chunk.byteLength) {
          const end = chunk.indexOf(10, start);
          const part = chunk.subarray(start, end === -1 ? chunk.byteLength : end);
          bytes += part.byteLength;
          if (bytes > MAX_FRAME_BYTES) throw new HarnessError("harness_event_gap", "Codex exceeded its protocol frame limit.");
          if (end === -1) {
            parts.push(part);
            break;
          }
          // Scan each chunk once; inline images must not cause repeated full-frame scans.
          let frame = part;
          if (parts.length) {
            frame = new Uint8Array(bytes);
            let offset = 0;
            for (const previous of parts) {
              frame.set(previous, offset);
              offset += previous.byteLength;
            }
            frame.set(part, offset);
          }
          const line = decoder.decode(frame);
          parts = [];
          bytes = 0;
          if (line.trim()) this.rpc.receive(line);
          start = end + 1;
        }
      }
      if (!this.closing) throw new HarnessError("harness_transport_closed", "Codex exited unexpectedly.");
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.rpc.fail(failure);
      if (!this.closing) for (const listener of this.failures) listener(failure);
    }
  }
}
