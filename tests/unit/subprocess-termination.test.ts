import { describe, expect, mock, spyOn, test } from "bun:test";
import { terminateSubprocessTree } from "../../src/core/subprocess-termination";

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
  const whichSpy = spyOn(Bun, "which").mockReturnValue(
    "C:\\Windows\\System32\\taskkill.exe",
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
});
