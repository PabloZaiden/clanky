/**
 * Owns an authenticated stdio-lifetime OpenCode 2 server and isolated v2 data.
 */

import { OpenCode, type OpenCodeClient } from "@opencode/client";
import { resolveAppDataDir } from "@pablozaiden/webapp/server";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { HarnessError } from "../harness-errors";

export class OpenCodeRuntime {
  private closing?: Promise<void>;
  private readonly failures = new Set<(error: Error) => void>();

  private constructor(
    readonly directory: string,
    readonly client: OpenCodeClient,
    private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">,
    private readonly stdout: Promise<void>,
    private readonly stderr: Promise<void>,
    readonly profileDirectory: string,
    private readonly requestAbort: AbortController,
  ) {}

  static async open(options: {
    directory: string;
    env?: NodeJS.ProcessEnv;
    executable?: string;
    profileDirectory?: string;
  }, signal?: AbortSignal): Promise<OpenCodeRuntime> {
    if (signal?.aborted) throw new HarnessError("harness_connection_aborted", "OpenCode startup was cancelled.");
    const executable = options.executable ?? Bun.which("opencode2", { PATH: options.env?.["PATH"] ?? process.env["PATH"] });
    if (!executable) throw new HarnessError("harness_runtime_unavailable", "OpenCode 2 CLI is not installed on the execution host.");
    const profile = options.profileDirectory ?? join(resolveAppDataDir({ envPrefix: "CLANKY", appDirectoryName: ".clanky" }), "native", "opencode2");
    const data = join(profile, "data");
    const cache = join(profile, "cache");
    const state = join(profile, "state");
    await Promise.all([data, cache, state].map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
    const password = crypto.randomUUID();
    const subprocess = Bun.spawn([executable, "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0", "--log-level", "error"], {
      cwd: options.directory,
      env: {
        ...process.env, ...options.env,
        XDG_DATA_HOME: data, XDG_CACHE_HOME: cache, XDG_STATE_HOME: state,
        OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_SERVER_PASSWORD: password,
      },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const ready = Promise.withResolvers<string>();
    const requestAbort = new AbortController();
    let runtime: OpenCodeRuntime | undefined;
    const stdout = (async () => {
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for await (const chunk of subprocess.stdout) {
          buffer += decoder.decode(chunk, { stream: true });
          let index: number;
          while ((index = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, index);
            buffer = buffer.slice(index + 1);
            if (line.length > 100_000) throw new HarnessError("harness_event_gap", "OpenCode exceeded its startup frame limit.");
            if (!line.startsWith("{")) continue;
            const frame = z.object({ url: z.string().optional() }).parse(JSON.parse(line));
            if (!frame.url) continue;
            const endpoint = new URL(frame.url);
            if (endpoint.hostname !== "127.0.0.1" || endpoint.protocol !== "http:" || !endpoint.port || endpoint.username || endpoint.password) {
              throw new HarnessError("harness_event_gap", "OpenCode published an unexpected native endpoint.");
            }
            ready.resolve(frame.url);
          }
          if (buffer.length > 100_000) throw new HarnessError("harness_event_gap", "OpenCode exceeded its startup frame limit.");
        }
        if (!runtime?.closing) throw new HarnessError("harness_transport_closed", "OpenCode exited unexpectedly.");
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        ready.reject(failure);
        if (runtime && !runtime.closing) for (const listener of runtime.failures) listener(failure);
      }
    })();
    const stderr = (async () => {
      try { for await (const _chunk of subprocess.stderr) {} } catch (error) {
        const failure = new HarnessError("harness_transport_closed", "OpenCode stderr observation failed.", { cause: error });
        ready.reject(failure);
        if (runtime && !runtime.closing) for (const listener of runtime.failures) listener(failure);
      }
    })();
    const startupAbort = new AbortController();
    const failStartup = (error: Error): void => {
      startupAbort.abort(error);
      ready.reject(error);
    };
    const onAbort = (): void => failStartup(new HarnessError("harness_connection_aborted", "OpenCode startup was cancelled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timeout = setTimeout(() => failStartup(new HarnessError("harness_request_failed", "OpenCode startup timed out.")), 30_000);
    try {
      const baseUrl = await ready.promise;
      runtime = new OpenCodeRuntime(options.directory, OpenCode.make({
        baseUrl, headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
        fetch: createNativeFetch(requestAbort.signal),
      }), subprocess, stdout, stderr, profile, requestAbort);
      const info = await runtime.client.server.info({ signal: startupAbort.signal });
      if (!Bun.semver.satisfies(info.version, ">=2.0.20 <3.0.0")) {
        throw new HarnessError("harness_runtime_unavailable", "The native adapter requires OpenCode runtime 2.0.20 or newer in generation 2.");
      }
      if (signal?.aborted) throw new HarnessError("harness_connection_aborted", "OpenCode startup was cancelled.");
      return runtime;
    } catch (error) {
      if (!runtime) {
        subprocess.stdin.end();
        subprocess.kill("SIGTERM");
        const force = setTimeout(() => subprocess.kill("SIGKILL"), 10_000);
        try { await subprocess.exited; } finally { clearTimeout(force); }
        await Promise.all([stdout, stderr]);
      } else {
        try { await runtime.close(); } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "OpenCode startup and teardown failed.");
        }
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  isOpen(): boolean { return !this.closing && this.process.exitCode === null; }
  onFailure(listener: (error: Error) => void): () => void {
    this.failures.add(listener);
    return () => this.failures.delete(listener);
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.requestAbort.abort(new HarnessError("harness_transport_closed", "The owned native runtime is closing."));
      this.process.stdin.end();
      const terminate = setTimeout(() => this.process.kill("SIGTERM"), 5_000);
      const force = setTimeout(() => this.process.kill("SIGKILL"), 10_000);
      try { await this.process.exited; } finally { clearTimeout(terminate); clearTimeout(force); }
      await Promise.all([this.stdout, this.stderr]);
      this.failures.clear();
    })();
    return this.closing;
  }

}

function createNativeFetch(lifetime: AbortSignal): typeof fetch {
  return Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const deadline = new AbortController();
    const signals = [lifetime, deadline.signal];
    if (input instanceof Request) signals.push(input.signal);
    if (init?.signal) signals.push(init.signal);
    const timer = setTimeout(() => deadline.abort(new HarnessError("harness_request_failed", "The native request timed out.")), 30_000);
    try {
      const response = await fetch(input, { ...init, signal: AbortSignal.any(signals) });
      if (response.headers.get("content-type")?.startsWith("text/event-stream")) return response;
      const body = await response.arrayBuffer();
      return new Response([204, 205, 304].includes(response.status) ? null : body, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
    } finally { clearTimeout(timer); }
  }, { preconnect: fetch.preconnect });
}
