/**
 * Git stash operations.
 */

import type { CommandExecutor } from "../command-executor";
import { log } from "@pablozaiden/webapp/server";
import { runGitCommand, gitError } from "./git-core";
import { ensureBranch } from "./git-branch";
import type { StashOptions } from "./git-types";

export async function stash(
  executor: CommandExecutor,
  directory: string,
  options: StashOptions = {}
): Promise<void> {
  if (options.expectedBranch) {
    const result = await ensureBranch(executor, directory, options.expectedBranch, { autoCheckout: true });
    if (result.checkedOut) {
      log.info(`[GitService] stash: Auto-recovered to branch '${options.expectedBranch}' before stash`);
    }
  }

  const args = ["stash", "push", "-u"];
  const result = await runGitCommand(executor, directory, args);
  if (!result.success) {
    throw gitError("Failed to stash changes", result, args);
  }
}

export async function stashPop(
  executor: CommandExecutor,
  directory: string,
  options: StashOptions = {}
): Promise<void> {
  if (options.expectedBranch) {
    const result = await ensureBranch(executor, directory, options.expectedBranch, { autoCheckout: true });
    if (result.checkedOut) {
      log.info(`[GitService] stashPop: Auto-recovered to branch '${options.expectedBranch}' before stash pop`);
    }
  }

  const args = ["stash", "pop"];
  const result = await runGitCommand(executor, directory, args);
  if (!result.success) {
    throw gitError("Failed to pop stash", result, args);
  }
}
