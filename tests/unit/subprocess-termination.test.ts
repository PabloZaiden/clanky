import { describe, expect, spyOn, test } from "bun:test";
import {
  SubprocessTreeTerminationError,
  terminateSubprocessTree,
} from "../../src/core/subprocess-termination";
import { pollUntil } from "../helpers/polling";

interface ControlledSubprocess {
  process: Bun.Subprocess;
  exit(exitCode: number): void;
}

function createControlledSubprocess(pid = 4242): ControlledSubprocess {
  let exitCode: number | null = null;
  let resolveExit!: (exitCode: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const kill = (): void => {};
  return {
    process: {
      pid,
      get exitCode() {
        return exitCode;
      },
      exited,
      kill,
    } as unknown as Bun.Subprocess,
    exit(nextExitCode: number): void {
      exitCode = nextExitCode;
      resolveExit(nextExitCode);
    },
  };
}

function createTaskkillProcess(
  onExit?: () => void,
  exitCode = 0,
): Bun.Subprocess {
  return {
    exited: Promise.resolve().then(() => {
      onExit?.();
      return exitCode;
    }),
  } as unknown as Bun.Subprocess;
}

async function withMockWindowsTermination(
  run: (options: {
    target: ControlledSubprocess;
    commands: string[][];
    setTaskkillFactory(
      factory: (command: string[]) => Bun.Subprocess,
    ): void;
  }) => Promise<void>,
  options: {
    taskkillPath?: string | null;
    systemRoot?: string | null;
  } = {},
): Promise<void> {
  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  )!;
  Object.defineProperty(process, "platform", {
    ...platformDescriptor,
    value: "win32",
  });
  const target = createControlledSubprocess();
  const commands: string[][] = [];
  let taskkillFactory: (command: string[]) => Bun.Subprocess =
    () => createTaskkillProcess();
  const originalSystemRoot = process.env["SystemRoot"];
  const originalWindowsDirectory = process.env["WINDIR"];
  if (options.systemRoot === null) {
    delete process.env["SystemRoot"];
    delete process.env["WINDIR"];
  } else if (options.systemRoot !== undefined) {
    process.env["SystemRoot"] = options.systemRoot;
  }
  const whichSpy = spyOn(Bun, "which").mockReturnValue(
    options.taskkillPath === undefined
      ? "C:\\Windows\\System32\\taskkill.exe"
      : options.taskkillPath,
  );
  const spawnSpy = spyOn(Bun, "spawn").mockImplementation(((
    command: string[],
  ): Bun.Subprocess => {
    commands.push([...command]);
    return taskkillFactory(command);
  }) as typeof Bun.spawn);
  try {
    await run({
      target,
      commands,
      setTaskkillFactory(factory): void {
        taskkillFactory = factory;
      },
    });
  } finally {
    spawnSpy.mockRestore();
    whichSpy.mockRestore();
    if (originalSystemRoot === undefined) {
      delete process.env["SystemRoot"];
    } else {
      process.env["SystemRoot"] = originalSystemRoot;
    }
    if (originalWindowsDirectory === undefined) {
      delete process.env["WINDIR"];
    } else {
      process.env["WINDIR"] = originalWindowsDirectory;
    }
    Object.defineProperty(process, "platform", platformDescriptor);
  }
}

describe("subprocess tree termination", () => {
  // An exited parent is not evidence that Windows also stopped its children.
  test("rejects an exited Windows root without confirmed tree termination", async () => {
    await withMockWindowsTermination(async ({ target }) => {
      target.exit(0);

      const firstError = await terminateSubprocessTree(target.process, {
        gracefulWaitMs: 0,
        forceWaitMs: 0,
        requireExit: true,
      }).then(() => null, (error: unknown) => error);
      const retryError = await terminateSubprocessTree(target.process, {
        gracefulWaitMs: 0,
        forceWaitMs: 0,
        requireExit: true,
      }).then(() => null, (error: unknown) => error);

      expect(firstError).toBeInstanceOf(SubprocessTreeTerminationError);
      expect(firstError).toMatchObject({ retryable: false });
      expect(retryError).toBe(firstError);
    });
  });

  // This deterministic contract proves that timeout escalation adds /F to the
  // same process-tree request rather than killing only the parent handle.
  test("forces the Windows process tree after the graceful wait expires", async () => {
    await withMockWindowsTermination(async ({ target, setTaskkillFactory }) => {
      setTaskkillFactory((command) => createTaskkillProcess(
        command.includes("/F") ? () => target.exit(0) : undefined,
      ));

      await terminateSubprocessTree(target.process, {
        gracefulWaitMs: 0,
        forceWaitMs: 0,
        requireExit: true,
      });
    });
  });

  // The failure contract is isolated to avoid leaving a real child tree alive
  // while still proving requireExit never reports successful cleanup.
  test("rejects when the Windows process survives forced tree termination", async () => {
    await withMockWindowsTermination(async ({ target }) => {
      await expect(terminateSubprocessTree(target.process, {
        gracefulWaitMs: 0,
        forceWaitMs: 0,
        requireExit: true,
      })).rejects.toThrow(
        "The subprocess tree did not exit after forced termination (pid 4242).",
      );
    });
  });

  // Once the root exits, retrying taskkill by PID could target a reused PID.
  // The retry contract must become permanently failed instead.
  test("marks a failed tree termination unrecoverable after root exit", async () => {
    await withMockWindowsTermination(async ({
      target,
      setTaskkillFactory,
    }) => {
      setTaskkillFactory(() => createTaskkillProcess(undefined, 1));

      const firstError = await terminateSubprocessTree(target.process, {
        gracefulWaitMs: 0,
        forceWaitMs: 0,
        requireExit: true,
      }).then(() => null, (error: unknown) => error);
      expect(firstError).toMatchObject({
        retryable: true,
      });

      target.exit(1);
      const retryError = await terminateSubprocessTree(target.process, {
        gracefulWaitMs: 0,
        forceWaitMs: 0,
        requireExit: true,
      }).then(() => null, (error: unknown) => error);

      expect(retryError).toBeInstanceOf(SubprocessTreeTerminationError);
      expect(retryError).toMatchObject({
        retryable: false,
        cause: firstError,
      });
    });
  });

  // POSIX retries can trust the completed handle after signal delivery; the
  // Windows-only PID reuse guard must not turn that completion into failure.
  test("accepts POSIX exit after a forced termination timeout", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    )!;
    Object.defineProperty(process, "platform", {
      ...platformDescriptor,
      value: "linux",
    });
    const target = createControlledSubprocess();
    try {
      const firstError = await terminateSubprocessTree(target.process, {
        gracefulWaitMs: 0,
        forceWaitMs: 0,
        requireExit: true,
      }).then(() => null, (error: unknown) => error);
      expect(firstError).toMatchObject({
        retryable: true,
      });

      target.exit(1);
      await expect(terminateSubprocessTree(target.process, {
        gracefulWaitMs: 0,
        forceWaitMs: 0,
        requireExit: true,
      })).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
    }
  });

  // A stuck taskkill helper must not consume the entire terminal/ACP teardown.
  test("terminates a hung taskkill helper before forced escalation", async () => {
    await withMockWindowsTermination(async ({
      target,
      commands,
      setTaskkillFactory,
    }) => {
      let resolveTaskkill!: (exitCode: number) => void;
      const taskkillExited = new Promise<number>((resolve) => {
        resolveTaskkill = resolve;
      });
      let helperReleased = false;
      const helperKill = (): void => {
        if (!helperReleased) {
          helperReleased = true;
          resolveTaskkill(1);
        }
      };
      setTaskkillFactory((command) => command.includes("/F")
        ? createTaskkillProcess(() => target.exit(0))
        : {
            exited: taskkillExited,
            kill: helperKill,
          } as unknown as Bun.Subprocess);
      let outcome: unknown;
      const termination = terminateSubprocessTree(target.process, {
        gracefulWaitMs: 10,
        forceWaitMs: 10,
        requireExit: true,
      }).then(
        () => {
          outcome = null;
        },
        (error: unknown) => {
          outcome = error;
        },
      );

      try {
        await pollUntil(
          () => outcome,
          (value) => value !== undefined,
          {
            description: "hung taskkill escalation",
            timeoutMs: 1_000,
          },
        );
      } finally {
        if (!helperReleased) {
          helperReleased = true;
          resolveTaskkill(1);
        }
        await termination;
      }

      expect(outcome).toBeNull();
      expect(commands[1]).toContain("/F");
    });
  });

  // A root-handle kill is not success for a tree contract; this protects ACP
  // and terminal descendants when no Windows tree-kill mechanism is available.
  test("rejects when Windows tree termination cannot be guaranteed", async () => {
    await withMockWindowsTermination(async ({ target }) => {
      target.process.kill = () => target.exit(0);

      await expect(terminateSubprocessTree(target.process, {
        gracefulWaitMs: 0,
        forceWaitMs: 0,
        requireExit: true,
      })).rejects.toThrow(
        "The Windows subprocess exited, but process-tree termination could not be guaranteed (pid 4242).",
      );
    }, {
      taskkillPath: null,
      systemRoot: null,
    });
  });
});
