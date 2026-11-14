import type { GitCommandOptions } from "./command-executor";
import { DomainError } from "../domain/domain-error";

export function assertGitCommand(
  args: readonly string[],
  options: Pick<GitCommandOptions, "scope" | "env">,
): void {
  if (
    options.env
    && Object.keys(options.env).some((name) => name !== "GIT_SSH_COMMAND")
  ) {
    throw new DomainError(
      "git_command_invalid",
      "Git operations only accept GIT_SSH_COMMAND.",
    );
  }
  const subcommand = args[0];
  if (!subcommand || subcommand.startsWith("-")) {
    throw new DomainError(
      "git_command_invalid",
      "Git operations require an explicit subcommand.",
    );
  }
  if (options.scope === "repository" && subcommand === "worktree") {
    throw new DomainError(
      "git_command_invalid",
      "Git worktree commands require the managedWorktrees scope.",
    );
  }
  if (
    options.scope === "managedWorktrees"
    && !["worktree", "rev-parse", "symbolic-ref"].includes(subcommand)
  ) {
    throw new DomainError(
      "git_command_invalid",
      "The managedWorktrees scope does not allow this Git subcommand.",
    );
  }
  if (options.scope !== "managedWorktrees" || subcommand !== "worktree") {
    return;
  }

  const action = args[1];
  let worktreePath: string;
  if (action === "list" && args.length === 3 && args[2] === "--porcelain") {
    return;
  }
  if (action === "prune" && args.length === 2) {
    return;
  }
  if (
    action === "remove"
    && (args.length === 3 || (args.length === 4 && args[3] === "--force"))
    && isGitOperand(args[2])
  ) {
    worktreePath = args[2];
  } else if (
    action === "add"
    && args.length === 5
    && args[2] === "--force"
    && isGitOperand(args[3])
    && isGitOperand(args[4])
  ) {
    worktreePath = args[3];
  } else if (
    action === "add"
    && args.length === 7
    && args[2] === "--track"
    && args[3] === "-b"
    && isGitOperand(args[4])
    && isGitOperand(args[5])
    && isGitOperand(args[6])
  ) {
    worktreePath = args[5];
  } else if (
    action === "add"
    && args.length === 4
    && isGitOperand(args[2])
    && isGitOperand(args[3])
  ) {
    worktreePath = args[2];
  } else if (
    action === "add"
    && (args.length === 5 || args.length === 6)
    && isGitOperand(args[2])
    && args[3] === "-b"
    && isGitOperand(args[4])
    && (args.length === 5 || isGitOperand(args[5]))
  ) {
    worktreePath = args[2];
  } else if (
    action === "add"
    && args.length === 6
    && args[2] === "--orphan"
    && args[3] === "-b"
    && isGitOperand(args[4])
    && isGitOperand(args[5])
  ) {
    worktreePath = args[5];
  } else {
    throw new DomainError(
      "git_command_invalid",
      "The managed worktree command is not supported.",
    );
  }
  if (!worktreePath.trim() || worktreePath.includes("\0")) {
    throw new DomainError(
      "git_command_invalid",
      "The managed worktree path must not be empty or contain NUL bytes.",
    );
  }
}

function isGitOperand(value: string | undefined): value is string {
  return Boolean(value && !value.startsWith("-"));
}
