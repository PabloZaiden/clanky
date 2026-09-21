import { describe, expect, test } from "bun:test";
import {
  GitService,
  InvalidManagedWorktreePathError,
} from "../../src/core/git";
import { ManagedPathService } from "../../src/core/managed-path-service";
import { TestCommandExecutor } from "../mocks/mock-executor";

describe("Managed worktree paths", () => {
  const paths = new ManagedPathService("posix");

  test("normalizes safe identifiers and rejects path traversal", () => {
    expect(paths.normalizeManagedWorktreeIdentifier(" task-123 ")).toBe("task-123");

    for (const identifier of ["", ".", "..", "../outside", "task/child", "task\\child", "task\0"]) {
      expect(() => paths.normalizeManagedWorktreeIdentifier(identifier)).toThrow(InvalidManagedWorktreePathError);
    }
  });

  test("accepts only direct children of the managed root", () => {
    const repoDirectory = "/remote/workspaces/repository";
    const worktreePath = paths.getManagedWorktreePath(repoDirectory, "task-123");

    expect(paths.isManagedWorktreePath(repoDirectory, worktreePath)).toBe(true);
    expect(paths.isManagedWorktreePath(repoDirectory, `${worktreePath}/`)).toBe(true);
    expect(paths.assertManagedWorktreePath(repoDirectory, `${worktreePath}/`)).toBe(worktreePath);

    expect(paths.isManagedWorktreePath(repoDirectory, paths.getManagedWorktreeRoot(repoDirectory))).toBe(false);
    expect(paths.isManagedWorktreePath(repoDirectory, `${worktreePath}/nested`)).toBe(false);
    expect(paths.isManagedWorktreePath(repoDirectory, `${repoDirectory}/outside`)).toBe(false);
    expect(paths.isManagedWorktreePath(repoDirectory, `${repoDirectory}/.clanky-worktrees/../outside`)).toBe(false);
    expect(() => paths.assertManagedWorktreePath(repoDirectory, `${repoDirectory}/outside`)).toThrow(
      InvalidManagedWorktreePathError,
    );
  });

  test("requires persisted paths to match their identifier-specific canonical path", () => {
    const repoDirectory = "/remote/workspaces/repository";
    const canonicalPath = paths.getManagedWorktreePath(repoDirectory, "task-123");

    expect(paths.assertCanonicalManagedWorktreePath(repoDirectory, "task-123", canonicalPath)).toBe(canonicalPath);
    expect(() => paths.assertCanonicalManagedWorktreePath(repoDirectory, "task-123", `${canonicalPath}/`)).toThrow(
      InvalidManagedWorktreePathError,
    );
    expect(() => paths.assertCanonicalManagedWorktreePath(
      repoDirectory,
      "task-123",
      paths.getManagedWorktreePath(repoDirectory, "task-456"),
    )).toThrow(InvalidManagedWorktreePathError);
  });

  test("uses Windows separators and case-insensitive containment", () => {
    const windowsPaths = new ManagedPathService("windows");
    const repoDirectory = String.raw`C:\work\repository`;
    const canonicalPath = String.raw`C:\work\repository\.clanky-worktrees\task-123`;

    expect(windowsPaths.getManagedWorktreePath(repoDirectory, "task-123")).toBe(canonicalPath);
    expect(windowsPaths.isManagedWorktreePath(
      String.raw`c:\WORK\repository`,
      String.raw`C:\work\REPOSITORY\.clanky-worktrees\TASK-123`,
    )).toBe(true);
    expect(windowsPaths.assertCanonicalManagedWorktreePath(
      repoDirectory,
      "task-123",
      String.raw`c:\WORK\repository\.clanky-worktrees\task-123`,
    )).toBe(canonicalPath);
    expect(windowsPaths.getPlanFilePath(repoDirectory)).toBe(
      String.raw`C:\work\repository\.clanky-planning\plan.md`,
    );
  });

  test("rejects Windows reserved and unstable path components", () => {
    const windowsPaths = new ManagedPathService("windows");

    for (const identifier of ["CON", "task.", "task:stream"]) {
      expect(() => windowsPaths.normalizeManagedWorktreeIdentifier(identifier)).toThrow(
        InvalidManagedWorktreePathError,
      );
    }
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
