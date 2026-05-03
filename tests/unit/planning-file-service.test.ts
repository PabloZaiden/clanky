import { describe, expect, test } from "bun:test";
import type { CommandExecutor, CommandOptions, CommandResult } from "../../src/core/command-executor";
import { readValidatedPlanningFiles } from "../../src/core/planning-file-service";
import { InvalidCurrentPlanError } from "../../src/types/chat";

class TestCommandExecutor implements CommandExecutor {
  readonly readFileCalls: string[] = [];

  constructor(private readonly files: Record<string, string>) {}

  async exec(_command: string, _args: string[], _options?: CommandOptions): Promise<CommandResult> {
    throw new Error("Unexpected exec call");
  }

  async fileExists(_path: string): Promise<boolean> {
    return false;
  }

  async directoryExists(_path: string): Promise<boolean> {
    return false;
  }

  async readFile(path: string): Promise<string | null> {
    this.readFileCalls.push(path);
    return this.files[path] ?? null;
  }

  async listDirectory(_path: string): Promise<string[]> {
    return [];
  }

  async writeFile(_path: string, _content: string): Promise<boolean> {
    return false;
  }
}

describe("readValidatedPlanningFiles", () => {
  test("accepts explicit Windows absolute plan paths", async () => {
    const executor = new TestCommandExecutor({
      "C:/shared/plans/imported-plan.md": "# Imported plan\n\n1. Review.\n",
      "C:/shared/plans/status.md": "# Imported status\n\nReady.",
    });

    const result = await readValidatedPlanningFiles(
      executor,
      "/workspace/chat",
      "C:\\shared\\plans\\imported-plan.md",
    );

    expect(result).toEqual({
      planContent: "# Imported plan\n\n1. Review.",
      statusContent: "# Imported status\n\nReady.",
    });
    expect(executor.readFileCalls).toEqual([
      "C:/shared/plans/imported-plan.md",
      "C:/shared/plans/status.md",
    ]);
  });

  test("rejects relative plan paths that escape the chat workspace", async () => {
    const executor = new TestCommandExecutor({});

    await expect(
      readValidatedPlanningFiles(executor, "/workspace/chat", "../shared/imported-plan.md"),
    ).rejects.toBeInstanceOf(InvalidCurrentPlanError);
    await expect(
      readValidatedPlanningFiles(executor, "/workspace/chat", "../shared/imported-plan.md"),
    ).rejects.toThrow("Relative plan file paths must stay within the current chat workspace.");
    expect(executor.readFileCalls).toHaveLength(0);
  });
});
