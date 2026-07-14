import { describe, expect, test } from "bun:test";
import {
  GitService,
  InvalidManagedWorktreePathError,
  assertManagedWorktreePath,
  getManagedWorktreePath,
  getManagedWorktreeRoot,
  isManagedWorktreePath,
  normalizeManagedWorktreeIdentifier,
} from "../../src/core/git";
import { TestCommandExecutor } from "../mocks/mock-executor";

describe("Managed worktree paths", () => {
  test("constructs paths from the explicit repository directory", () => {
    expect(getManagedWorktreeRoot("/remote/workspaces/repository")).toBe(
      "/remote/workspaces/repository/.clanky-worktrees",
    );
    expect(getManagedWorktreePath("/remote/workspaces/repository", "task-123")).toBe(
      "/remote/workspaces/repository/.clanky-worktrees/task-123",
    );
    expect(getManagedWorktreePath("remote/workspaces/repository", "chat-123")).toBe(
      "remote/workspaces/repository/.clanky-worktrees/chat-123",
    );
  });

  test("normalizes safe identifiers and rejects path traversal", () => {
    expect(normalizeManagedWorktreeIdentifier(" task-123 ")).toBe("task-123");

    for (const identifier of ["", ".", "..", "../outside", "task/child", "task\\child", "task\0"]) {
      expect(() => normalizeManagedWorktreeIdentifier(identifier)).toThrow(InvalidManagedWorktreePathError);
    }
  });

  test("accepts only direct children of the managed root", () => {
    const repoDirectory = "/remote/workspaces/repository";
    const worktreePath = getManagedWorktreePath(repoDirectory, "task-123");

    expect(isManagedWorktreePath(repoDirectory, worktreePath)).toBe(true);
    expect(isManagedWorktreePath(repoDirectory, `${worktreePath}/`)).toBe(true);
    expect(assertManagedWorktreePath(repoDirectory, `${worktreePath}/`)).toBe(worktreePath);

    expect(isManagedWorktreePath(repoDirectory, getManagedWorktreeRoot(repoDirectory))).toBe(false);
    expect(isManagedWorktreePath(repoDirectory, `${worktreePath}/nested`)).toBe(false);
    expect(isManagedWorktreePath(repoDirectory, `${repoDirectory}/outside`)).toBe(false);
    expect(isManagedWorktreePath(repoDirectory, `${repoDirectory}/.clanky-worktrees/../outside`)).toBe(false);
    expect(() => assertManagedWorktreePath(repoDirectory, `${repoDirectory}/outside`)).toThrow(
      InvalidManagedWorktreePathError,
    );
  });

  test("rejects unsafe lookup and cleanup paths before executor operations", async () => {
    const git = new GitService(new TestCommandExecutor());
    const unsafePath = "/remote/workspaces/repository/outside";

    await expect(git.worktreeExists("/remote/workspaces/repository", unsafePath)).rejects.toThrow(
      InvalidManagedWorktreePathError,
    );
    await expect(git.ensureWorktreeRemoved("/remote/workspaces/repository", unsafePath)).rejects.toThrow(
      InvalidManagedWorktreePathError,
    );
  });
});
