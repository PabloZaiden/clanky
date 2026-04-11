import { describe, expect, test } from "bun:test";
import type { CommandExecutor, CommandOptions, CommandResult } from "../../src/core/command-executor";
import { PushedLoopMonitor } from "../../src/core/pushed-loop-monitor";
import type { PullRequestNavigationGitService } from "../../src/core/pull-request-navigation";
import { createLoopWithStatus } from "../frontend/helpers/factories";

class StubExecutor implements CommandExecutor {
  private responses = new Map<string, CommandResult>();

  addResponse(command: string, args: string[], result: CommandResult): void {
    this.responses.set(this.key(command, args), result);
  }

  async exec(command: string, args: string[], _options?: CommandOptions): Promise<CommandResult> {
    return this.responses.get(this.key(command, args)) ?? {
      success: false,
      stdout: "",
      stderr: `Unexpected command: ${command} ${args.join(" ")}`,
      exitCode: 1,
    };
  }

  async fileExists(_path: string): Promise<boolean> {
    return false;
  }

  async directoryExists(_path: string): Promise<boolean> {
    return true;
  }

  async readFile(_path: string): Promise<string | null> {
    return null;
  }

  async listDirectory(_path: string): Promise<string[]> {
    return [];
  }

  async writeFile(_path: string, _content: string): Promise<boolean> {
    return false;
  }

  private key(command: string, args: string[]): string {
    return `${command}\u0000${args.join("\u0000")}`;
  }
}

class StubGitService implements PullRequestNavigationGitService {
  remoteUrl = "git@github.com:owner/repo.git";

  async getDefaultBranch(_directory: string): Promise<string> {
    return "main";
  }

  async getRemoteUrl(_directory: string, _remote = "origin"): Promise<string> {
    return this.remoteUrl;
  }
}

describe("PushedLoopMonitor", () => {
  test("start only registers one interval and stop clears it", async () => {
    const originalSetInterval = globalThis.setInterval;
    const originalClearInterval = globalThis.clearInterval;
    let setIntervalCalls = 0;
    let clearIntervalCalls = 0;

    globalThis.setInterval = (((handler: TimerHandler, _timeout?: number) => {
      setIntervalCalls += 1;
      void handler;
      return 123 as unknown as ReturnType<typeof setInterval>;
    }) as unknown) as typeof setInterval;
    globalThis.clearInterval = (((_id?: ReturnType<typeof setInterval>) => {
      clearIntervalCalls += 1;
    }) as unknown) as typeof clearInterval;

    try {
      const executor = new StubExecutor();
      const monitor = new PushedLoopMonitor({
        listLoops: async () => [],
        loadLoop: async () => null,
        updateLoopState: async () => true,
        getCommandExecutor: async () => executor,
        createGitService: () => new StubGitService(),
        markMerged: async () => ({ success: true }),
        intervalMs: 60_000,
      });

      monitor.start();
      monitor.start();
      monitor.stop();

      expect(setIntervalCalls).toBe(1);
      expect(clearIntervalCalls).toBe(1);
    } finally {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    }
  });

  test("auto-marks a pushed loop as merged only once", async () => {
    const executor = new StubExecutor();
    const git = new StubGitService();
    const storedLoop = createLoopWithStatus("pushed", {
      config: {
        directory: "/tmp/repo",
        workspaceId: "workspace-1",
      },
      state: {
        git: {
          originalBranch: "main",
          workingBranch: "feature/auto-merge",
          worktreePath: "/tmp/repo/.worktrees/feature-auto-merge",
          commits: [],
        },
        reviewMode: {
          addressable: true,
          completionAction: "push",
          reviewCycles: 0,
          reviewBranches: ["feature/auto-merge"],
        },
      },
    });
    let markMergedCalls = 0;

    executor.addResponse("gh", ["--version"], {
      success: true,
      stdout: "gh version 2.0.0",
      stderr: "",
      exitCode: 0,
    });
    executor.addResponse("gh", ["pr", "view", "feature/auto-merge", "--json", "number,url,state,mergedAt"], {
      success: true,
      stdout: JSON.stringify({
        number: 42,
        url: "https://github.com/owner/repo/pull/42",
        state: "MERGED",
        mergedAt: "2026-04-11T04:00:00.000Z",
      }),
      stderr: "",
      exitCode: 0,
    });

    const monitor = new PushedLoopMonitor({
      listLoops: async () => [storedLoop],
      loadLoop: async () => storedLoop,
      updateLoopState: async (_loopId, state) => {
        storedLoop.state = state;
        return true;
      },
      getCommandExecutor: async () => executor,
      createGitService: () => git,
      markMerged: async () => {
        markMergedCalls += 1;
        storedLoop.state = {
          ...storedLoop.state,
          status: "merged",
          reviewMode: storedLoop.state.reviewMode
            ? { ...storedLoop.state.reviewMode, addressable: false }
            : undefined,
        };
        return { success: true };
      },
      intervalMs: 60_000,
    });

    await monitor.runNow();
    await monitor.runNow();

    expect(markMergedCalls).toBe(1);
    expect(storedLoop.state.status).toBe("merged");
    expect(storedLoop.state.pullRequestMonitoring).toEqual({
      status: "merged",
      lastCheckedAt: expect.any(String),
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/owner/repo/pull/42",
      mergedAt: "2026-04-11T04:00:00.000Z",
    });
  });

  test("runNow swallows scheduler-level failures and resets overlap protection", async () => {
    let listCalls = 0;
    const monitor = new PushedLoopMonitor({
      listLoops: async () => {
        listCalls += 1;
        if (listCalls === 1) {
          throw new Error("database unavailable");
        }
        return [];
      },
      loadLoop: async () => null,
      updateLoopState: async () => true,
      getCommandExecutor: async () => new StubExecutor(),
      createGitService: () => new StubGitService(),
      markMerged: async () => ({ success: true }),
      intervalMs: 60_000,
    });

    await expect(monitor.runNow()).resolves.toBeUndefined();
    await expect(monitor.runNow()).resolves.toBeUndefined();

    expect(listCalls).toBe(2);
  });
});
