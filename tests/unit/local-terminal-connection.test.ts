import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTerminalConnection } from "../../src/core/terminal/local-terminal-connection";
import { pollUntil } from "../helpers/polling";
import { TestCommandExecutor } from "../mocks/mock-executor";

interface ControlledProcess {
  subprocess: Bun.Subprocess;
  exit(exitCode: number): void;
}

function createControlledProcess(): ControlledProcess {
  let exitCode: number | null = null;
  let resolveExit!: (exitCode: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  return {
    subprocess: {
      pid: 4242,
      get exitCode() {
        return exitCode;
      },
      exited,
      signalCode: null,
      kill(): void {},
    } as unknown as Bun.Subprocess,
    exit(nextExitCode: number): void {
      exitCode = nextExitCode;
      resolveExit(nextExitCode);
    },
  };
}

describe("LocalTerminalConnection lifecycle", () => {
  // This lifecycle seam deterministically forces startup and tree-termination
  // failures without leaking a real shell process on the test host.
  test("bounds retained resources when startup tree cleanup cannot be confirmed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "clanky-terminal-startup-"));
    const controlled = createControlledProcess();
    const spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
      controlled.subprocess,
    );
    const connection = new LocalTerminalConnection({
      sessionId: crypto.randomUUID(),
      remoteSessionName: `clanky-test-${crypto.randomUUID()}`,
      directory,
      connectionMode: "direct",
      useTmux: false,
      executor: new TestCommandExecutor(directory),
      callbacks: {
        onOutput(): void {},
      },
    });
    const startupError = new Error("terminal startup failed");
    const internals = connection as unknown as {
      waitUntilReady(processHandle: Bun.Subprocess): Promise<void>;
      terminateProcess(processHandle: Bun.Subprocess): Promise<void>;
      retainedProcess: Bun.Subprocess | null;
      retainedProcessRetryTimer?: ReturnType<typeof setInterval>;
      process: Bun.Subprocess | null;
      terminal: Bun.Terminal | null;
      processTreeCleanupFailure: Bun.Subprocess | null;
    };
    internals.waitUntilReady = async () => {
      throw startupError;
    };
    let terminationAttempts = 0;
    internals.terminateProcess = async (processHandle) => {
      terminationAttempts += 1;
      if (terminationAttempts === 1) {
        internals.processTreeCleanupFailure = processHandle;
        throw new Error("tree termination failed");
      }
    };

    try {
      await expect(connection.connect()).rejects.toBe(startupError);
      expect(internals.retainedProcess).toBe(controlled.subprocess);
      expect(internals.terminal).not.toBeNull();

      controlled.exit(1);
      await pollUntil(
        () => ({
          retainedProcess: internals.retainedProcess,
          retainedProcessRetryTimer: internals.retainedProcessRetryTimer,
          process: internals.process,
          terminal: internals.terminal,
        }),
        (state) => (
          state.retainedProcess === null
          && state.retainedProcessRetryTimer === undefined
          && state.process === null
          && state.terminal === null
        ),
        {
          description: "bounded startup process cleanup",
          timeoutMs: 1_000,
          formatLastObserved: (state) => JSON.stringify({
            retained: state.retainedProcess !== null,
            retryTimer: state.retainedProcessRetryTimer !== undefined,
            process: state.process !== null,
            terminal: state.terminal !== null,
          }),
        },
      );
      expect(terminationAttempts).toBe(1);
    } finally {
      controlled.exit(1);
      spawnSpy.mockRestore();
      await connection.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
