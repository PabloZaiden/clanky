import { describe, expect, mock, spyOn, test } from "bun:test";
import { terminateSubprocessTree } from "../../src/core/subprocess-termination";
import { pollUntil } from "../helpers/polling";

interface ControlledSubprocess {
  process: Bun.Subprocess;
  exit(exitCode: number): void;
  kill: ReturnType<typeof mock>;
}

function createControlledSubprocess(pid = 4242): ControlledSubprocess {
  let exitCode: number | null = null;
  let resolveExit!: (exitCode: number) => void;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const kill = mock(() => undefined);
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
    kill,
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
  // A unit seam is justified because forcing taskkill timeout states through a
  // public API would risk killing unrelated Windows host processes.
  test("stops a Windows process tree without forcing when taskkill exits it", async () => {
    await withMockWindowsTermination(async ({
      target,
      commands,
      setTaskkillFactory,
    }) => {
      setTaskkillFactory(() => createTaskkillProcess(() => target.exit(0)));

      await terminateSubprocessTree(target.process, {
        gracefulWaitMs: 0,
        forceWaitMs: 0,
        requireExit: true,
      });

      expect(commands).toEqual([[
        "C:\\Windows\\System32\\taskkill.exe",
        "/PID",
        "4242",
        "/T",
      ]]);
      expect(target.kill).not.toHaveBeenCalled();
    });
  });

  // This deterministic contract proves that timeout escalation adds /F to the
  // same process-tree request rather than killing only the parent handle.
  test("forces the Windows process tree after the graceful wait expires", async () => {
    await withMockWindowsTermination(async ({
      target,
      commands,
      setTaskkillFactory,
    }) => {
      setTaskkillFactory((command) => createTaskkillProcess(
        command.includes("/F") ? () => target.exit(0) : undefined,
      ));

      await terminateSubprocessTree(target.process, {
        gracefulWaitMs: 0,
        forceWaitMs: 0,
        requireExit: true,
      });

      expect(commands).toEqual([
        [
          "C:\\Windows\\System32\\taskkill.exe",
          "/PID",
          "4242",
          "/T",
        ],
        [
          "C:\\Windows\\System32\\taskkill.exe",
          "/PID",
          "4242",
          "/T",
          "/F",
        ],
      ]);
      expect(target.kill).not.toHaveBeenCalled();
    });
  });

  // The failure contract is isolated to avoid leaving a real child tree alive
  // while still proving requireExit never reports successful cleanup.
  test("rejects when the Windows process survives forced tree termination", async () => {
    await withMockWindowsTermination(async ({ target, commands }) => {
      await expect(terminateSubprocessTree(target.process, {
        gracefulWaitMs: 0,
        forceWaitMs: 0,
        requireExit: true,
      })).rejects.toThrow(
        "The subprocess tree did not exit after forced termination (pid 4242).",
      );

      expect(commands).toHaveLength(2);
      expect(commands[1]).toContain("/F");
      expect(target.kill).not.toHaveBeenCalled();
    });
  });

  // SystemRoot is the stable Windows fallback when taskkill is absent from the
  // inherited PATH, which is common for services with a restricted environment.
  test("resolves taskkill from the Windows system directory", async () => {
    await withMockWindowsTermination(async ({
      target,
      commands,
      setTaskkillFactory,
    }) => {
      setTaskkillFactory(() => createTaskkillProcess(() => target.exit(0)));

      await terminateSubprocessTree(target.process, {
        gracefulWaitMs: 0,
        forceWaitMs: 0,
        requireExit: true,
      });

      expect(commands[0]?.[0]).toBe(
        "D:\\Windows\\System32\\taskkill.exe",
      );
    }, {
      taskkillPath: null,
      systemRoot: "D:\\Windows",
    });
  });

  // The root process exiting does not prove that a failed taskkill invocation
  // terminated its descendants, so requireExit must preserve that failure.
  test("rejects when taskkill fails after the root process exits", async () => {
    await withMockWindowsTermination(async ({
      target,
      commands,
      setTaskkillFactory,
    }) => {
      setTaskkillFactory(() => createTaskkillProcess(
        () => target.exit(1),
        1,
      ));

      await expect(terminateSubprocessTree(target.process, {
        gracefulWaitMs: 0,
        forceWaitMs: 0,
        requireExit: true,
      })).rejects.toThrow(
        "The Windows subprocess exited, but process-tree termination could not be guaranteed (pid 4242).",
      );

      expect(commands).toHaveLength(1);
      expect(target.kill).not.toHaveBeenCalled();
    });
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
      const helperKill = mock(() => {
        if (!helperReleased) {
          helperReleased = true;
          resolveTaskkill(1);
        }
      });
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
      expect(helperKill).toHaveBeenCalledTimes(1);
      expect(commands[1]).toContain("/F");
    });
  });

  // A root-handle kill is not success for a tree contract; this protects ACP
  // and terminal descendants when no Windows tree-kill mechanism is available.
  test("rejects when Windows tree termination cannot be guaranteed", async () => {
    await withMockWindowsTermination(async ({ target, commands }) => {
      target.kill.mockImplementation(() => target.exit(0));

      await expect(terminateSubprocessTree(target.process, {
        gracefulWaitMs: 0,
        forceWaitMs: 0,
        requireExit: true,
      })).rejects.toThrow(
        "The Windows subprocess exited, but process-tree termination could not be guaranteed (pid 4242).",
      );

      expect(commands).toEqual([]);
      expect(target.kill).toHaveBeenCalledTimes(1);
    }, {
      taskkillPath: null,
      systemRoot: null,
    });
  });
});
