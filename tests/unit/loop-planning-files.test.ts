import { describe, expect, spyOn, test } from "bun:test";
import type { CommandExecutor, CommandOptions, CommandResult } from "../../src/core/command-executor";
import { clearPlanningFilesImpl } from "../../src/core/loop/loop-planning-files";
import { PLANNING_DIRECTORY_NAME } from "../../src/lib/planning-files";
import type { Loop, LoopConfig, LoopState } from "../../src/types/loop";
import * as loopPersistence from "../../src/persistence/loops";
import { log } from "../../src/core/logger";

class TestCommandExecutor implements CommandExecutor {
  directoryExistsCalls = 0;

  constructor(
    private readonly rmResult: CommandResult,
    private readonly planningEntries: string[],
  ) {}

  async exec(command: string, _args: string[], _options?: CommandOptions): Promise<CommandResult> {
    if (command === "rm") {
      return this.rmResult;
    }

    if (command === "mkdir") {
      return { success: true, stdout: "", stderr: "", exitCode: 0 };
    }

    throw new Error(`Unexpected command: ${command}`);
  }

  async fileExists(_path: string): Promise<boolean> {
    return false;
  }

  async directoryExists(_path: string): Promise<boolean> {
    this.directoryExistsCalls += 1;
    return true;
  }

  async readFile(_path: string): Promise<string | null> {
    return null;
  }

  async listDirectory(_path: string): Promise<string[]> {
    return [...this.planningEntries];
  }

  async writeFile(_path: string, _content: string): Promise<boolean> {
    return false;
  }
}

function createTestLoop(): Loop {
  const config: LoopConfig = {
    id: "loop-1",
    name: "Loop",
    directory: "/repo",
    prompt: "Do work",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workspaceId: "workspace-1",
    model: { providerID: "test-provider", modelID: "test-model", variant: "" },
    maxIterations: 1,
    maxConsecutiveErrors: 1,
    activityTimeoutSeconds: 60,
    stopPattern: "<promise>COMPLETE</promise>$",
    git: { branchPrefix: "", commitScope: "" },
    useWorktree: false,
    clearPlanningFolder: true,
    planMode: true,
    mode: "loop",
  };

  const state: LoopState = {
    id: config.id,
    status: "idle",
    currentIteration: 0,
    recentIterations: [],
    logs: [],
    messages: [],
    toolCalls: [],
    planMode: {
      active: true,
      feedbackRounds: 0,
      planningFolderCleared: false,
      isPlanReady: false,
    },
  };

  return { config, state };
}

describe("clearPlanningFilesImpl", () => {
  test("does not mark planningFolderCleared when rm fails and avoids redundant directory checks", async () => {
    const updateLoopStateSpy = spyOn(loopPersistence, "updateLoopState").mockResolvedValue(true);
    const warnSpy = spyOn(log, "warn").mockImplementation(() => undefined);
    const loop = createTestLoop();
    const executor = new TestCommandExecutor(
      { success: false, stdout: "", stderr: "permission denied", exitCode: 1 },
      [".gitkeep", "plan.md"],
    );

    await clearPlanningFilesImpl({} as never, loop.config.id, loop, executor, "/repo");

    expect(executor.directoryExistsCalls).toBe(1);
    expect(loop.state.planMode?.planningFolderCleared).toBe(false);
    expect(updateLoopStateSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      `Failed to clear ${PLANNING_DIRECTORY_NAME} folder: Error: Failed to clear /repo/${PLANNING_DIRECTORY_NAME}: permission denied`,
    );

    updateLoopStateSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
