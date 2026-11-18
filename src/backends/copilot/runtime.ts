/**
 * Owns one attached Copilot SDK runtime and its deterministic shutdown.
 */

import {
  CopilotClient,
  RuntimeConnection,
  type GetStatusResponse,
} from "@microsoft/copilot-sdk";
import { createLogger } from "@pablozaiden/webapp/server";
import { HarnessError } from "../harness-errors";

const log = createLogger("backend:copilot:runtime");

export interface CopilotRuntimeOptions {
  directory: string;
  executable?: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export class CopilotRuntime {
  private disposal?: Promise<void>;

  private constructor(
    readonly client: CopilotClient,
    readonly directory: string,
    readonly status: GetStatusResponse,
  ) {}

  static async open(options: CopilotRuntimeOptions, signal?: AbortSignal): Promise<CopilotRuntime> {
    if (!options.directory.trim()) {
      throw new HarnessError("harness_request_failed", "Copilot runtime requires an execution-host directory.");
    }
    if (options.executable !== undefined && !options.executable.trim()) {
      throw new HarnessError("harness_runtime_unavailable", "Copilot runtime executable is empty.");
    }
    const executable = options.executable ?? Bun.which("copilot", {
      PATH: options.env?.["PATH"] ?? process.env["PATH"],
      cwd: options.directory,
    });
    if (!executable) {
      throw new HarnessError("harness_runtime_unavailable", "Copilot CLI is not installed on the execution host.");
    }
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...process.env, ...options.env })) {
      if (value !== undefined) environment[key] = value;
    }
    const client = new CopilotClient({
      mode: "coding-agent",
      runtime: RuntimeConnection.forSpawnedStdio({
        path: executable,
        args: options.args,
        env: environment,
        workingDirectory: options.directory,
      }),
      observability: { logLevel: "error" },
    });
    const aborted = Promise.withResolvers<never>();
    const onAbort = (): void => {
      aborted.reject(new HarnessError("harness_connection_aborted", "Copilot runtime startup was cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const startup = async (): Promise<GetStatusResponse> => {
      if (signal?.aborted) {
        throw new HarnessError("harness_connection_aborted", "Copilot runtime startup was cancelled.");
      }
      await client.start();
      const authenticated = await client.getAuthStatus();
      if (!authenticated.isAuthenticated) {
        throw new HarnessError("harness_authentication_required", "Copilot CLI requires authentication.");
      }
      return client.getStatus();
    };
    try {
      const status = await Promise.race([startup(), aborted.promise]);
      if (signal?.aborted) {
        throw new HarnessError("harness_connection_aborted", "Copilot runtime startup was cancelled.");
      }
      return new CopilotRuntime(client, options.directory, status);
    } catch (error) {
      // Only extract protocol metadata: other SDK errors can include child output.
      const mismatch = error instanceof Error
        ? /^SDK protocol version mismatch: SDK supports versions (\d{1,9})-(\d{1,9}), but server (?:reports version (\d{1,9})|does not report a protocol version)\./.exec(error.message)
        : null;
      if (mismatch) {
        log.error("Copilot SDK and CLI protocols are incompatible; align Clanky and Copilot versions on the execution host", {
          minimumProtocol: Number(mismatch[1]),
          maximumProtocol: Number(mismatch[2]),
          runtimeProtocol: mismatch[3] === undefined ? "unreported" : Number(mismatch[3]),
        });
      }
      let shutdownErrors: Error[];
      try {
        shutdownErrors = await client.stop();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "Copilot startup and runtime cleanup failed.");
      }
      if (shutdownErrors.length > 0) {
        throw new AggregateError([error, ...shutdownErrors], "Copilot startup and runtime cleanup failed.");
      }
      if (error instanceof HarnessError) throw error;
      throw new HarnessError("harness_request_failed", "Copilot runtime startup failed.", { cause: error });
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  isOpen(): boolean {
    return this.disposal === undefined;
  }

  close(): Promise<void> {
    this.disposal ??= (async () => {
      const errors = await this.client.stop();
      if (errors.length > 0) {
        throw new AggregateError(errors, "Copilot runtime shutdown failed.");
      }
    })();
    return this.disposal;
  }
}
